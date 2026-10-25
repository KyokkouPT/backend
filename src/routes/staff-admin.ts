import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import {
  API_PREFIX,
  PERMISSIONS,
  anomaliesResponse,
  appealResolveBody,
  appealsResponse,
  auditResponse,
  reportsResponse,
  resolveAnomalyBody,
  resolveReportBody,
  staffActionResponse,
  staffSummaryResponse,
  staffUsersResponse,
  type AppealItem,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { currentSchemaVersion } from "../db/migrate.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { permissionsFor } from "../auth/permissions.js";
import { deleteAllSessionsOfUser } from "../auth/session.js";
import { loadAppeals } from "../lib/appeals.js";
import { createNotification } from "../lib/notifications.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { hueFor, numberCount, ratioFor } from "../lib/serialize.js";
import { parseOrThrow } from "../lib/validate.js";

function requirePerm(request: FastifyRequest, permission: string) {
  const auth = requireAuth(request);
  if (!permissionsFor(auth.user.role).includes(permission)) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

async function countWhere(db: Db, table: "torrents" | "reports" | "anomalies" | "users", column: string, value: string) {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where(sql<boolean>`${sql.ref(column)} = ${value}`)
    .executeTakeFirst();
  return numberCount(row);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function staffAdminRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/staff/summary`, async (request) => {
      requirePerm(request, PERMISSIONS.staffAccess);
      const [users, torrents, schemaVersion] = await Promise.all([
        countWhere(db, "users", "status", "active"),
        countWhere(db, "torrents", "status", "approved"),
        currentSchemaVersion(db),
      ]);

      return staffSummaryResponse.parse({
        pending_review: await countWhere(db, "torrents", "status", "pending"),
        open_reports: await countWhere(db, "reports", "status", "open"),
        anomalies: await countWhere(db, "anomalies", "status", "open"),
        users,
        torrents,
        schema_version: schemaVersion,
      });
    });

    app.get(`${API_PREFIX}/staff/users`, async (request) => {
      requirePerm(request, PERMISSIONS.staffUsers);
      const query = request.query as { q?: string };
      let builder = db.selectFrom("users").selectAll();
      if (query.q && query.q.trim().length > 0) {
        const needle = `%${query.q.trim().toLowerCase()}%`;
        builder = builder.where((eb) =>
          eb.or([
            eb("username", "like", needle as never),
            eb("email", "like", needle as never),
          ]),
        );
      }
      const rows = await builder.orderBy("id", "asc").limit(50).execute();

      return staffUsersResponse.parse({
        items: rows.map((user) => ({
          id: Number(user.id),
          username: user.username,
          email: user.email,
          role: user.role,
          class_key: user.class_key,
          status: user.status,
          uploaded: Number(user.uploaded),
          downloaded: Number(user.downloaded),
          ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
          bonus: Number(user.bonus),
          created_at: Number(user.created_at),
          last_seen_at: user.last_seen_at === null ? null : Number(user.last_seen_at),
        })),
      });
    });

    app.post(`${API_PREFIX}/staff/users/:id/:action`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffUsers);
      assertCsrf(request, auth.session);

      const { id: rawId, action } = request.params as { id: string; action: string };
      if (!["warn", "suspend", "ban", "restore"].includes(action)) {
        throw notFound("invalid_action", "不支持的操作");
      }
      const id = Number(rawId);
      const target = await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
      if (!target) throw notFound("user_not_found", "用户不存在");
      if (Number(target.id) === Number(auth.user.id)) throw badRequest("self_action", "不能对自己执行该操作");

      const now = Date.now();
      const nextStatus =
        action === "suspend" ? "suspended" : action === "ban" ? "banned" : action === "restore" ? "active" : target.status;

      await db.updateTable("users").set({ status: nextStatus }).where("id", "=", id).execute();
      if (action === "suspend" || action === "ban") {
        await deleteAllSessionsOfUser(db, id);
      }

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: `user.${action}`,
          target_type: "user",
          target_id: String(id),
          detail_json: JSON.stringify({ status: nextStatus }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      await createNotification(db, {
        userId: id,
        kind: "account",
        title: "账号状态变更",
        body:
          action === "warn"
            ? "你收到一条 Staff 警告，请遵守站点规则。"
            : action === "suspend"
              ? "你的账号已被停用，可通过申诉入口说明情况。"
              : action === "ban"
                ? "你的账号已被封禁，可通过免登录申诉入口提交申诉。"
                : "你的账号已恢复为正常状态。",
        linkUrl: "/appeals",
      });

      return staffActionResponse.parse({
        ok: true,
        status: nextStatus,
        message:
          action === "warn"
            ? "已发送警告"
            : action === "suspend"
              ? "已停用并撤销 session"
              : action === "ban"
                ? "已封禁并撤销 session"
                : "已恢复",
      });
    });

    app.get(`${API_PREFIX}/staff/reports`, async (request) => {
      requirePerm(request, PERMISSIONS.staffReports);
      const query = request.query as { status?: string };
      let builder = db
        .selectFrom("reports as r")
        .leftJoin("users as u", "u.id", "r.reporter_id")
        .select([
          "r.id as id",
          "r.target_type as target_type",
          "r.target_id as target_id",
          "r.target_label as target_label",
          "r.reason as reason",
          "r.detail as detail",
          "r.status as status",
          "r.created_at as created_at",
          "r.resolved_at as resolved_at",
          "u.username as reporter",
        ]);
      if (query.status) builder = builder.where("r.status", "=", query.status);
      const rows = await builder.orderBy("r.created_at", "desc").limit(100).execute();

      return reportsResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          reporter: row.reporter,
          target_type: row.target_type,
          target_id: row.target_id,
          target_label: row.target_label,
          reason: row.reason,
          detail: row.detail,
          status: row.status,
          created_at: Number(row.created_at),
          resolved_at: row.resolved_at === null ? null : Number(row.resolved_at),
        })),
      });
    });

    app.post(`${API_PREFIX}/staff/reports/:id/resolve`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffReports);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(resolveReportBody, request.body ?? {});

      const report = await db.selectFrom("reports").selectAll().where("id", "=", id).executeTakeFirst();
      if (!report) throw notFound("report_not_found", "举报不存在");
      if (report.status !== "open") throw conflict("report_not_open", "举报已处理");

      const now = Date.now();
      const status = body.action === "resolve" ? "resolved" : "dismissed";
      await db
        .updateTable("reports")
        .set({ status, resolved_by: Number(auth.user.id), resolved_at: now })
        .where("id", "=", id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: `report.${body.action}`,
          target_type: "report",
          target_id: String(id),
          detail_json: JSON.stringify({ reason: body.reason ?? null }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      await createNotification(db, {
        userId: Number(report.reporter_id),
        kind: "report",
        title: status === "resolved" ? "举报已成立" : "举报未成立",
        body: `你举报的「${report.target_label}」已处理：${body.reason ?? (status === "resolved" ? "违规成立" : "未发现违规")}`,
        linkUrl: null,
      });

      return staffActionResponse.parse({
        ok: true,
        status,
        message: status === "resolved" ? "举报已成立" : "举报已驳回",
      });
    });

    app.get(`${API_PREFIX}/staff/anomalies`, async (request) => {
      requirePerm(request, PERMISSIONS.staffAnomalies);
      const query = request.query as { status?: string };
      let builder = db
        .selectFrom("anomalies as a")
        .innerJoin("users as u", "u.id", "a.user_id")
        .select([
          "a.id as id",
          "a.kind as kind",
          "a.severity as severity",
          "a.status as status",
          "a.detail_json as detail_json",
          "a.created_at as created_at",
          "a.resolved_at as resolved_at",
          "u.id as user_id",
          "u.username as username",
        ]);
      if (query.status) builder = builder.where("a.status", "=", query.status);
      const rows = await builder.orderBy("a.created_at", "desc").limit(100).execute();

      return anomaliesResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          user: { name: row.username, hue: hueFor(row.username) },
          kind: row.kind,
          severity: row.severity,
          status: row.status,
          detail: row.detail_json,
          created_at: Number(row.created_at),
          resolved_at: row.resolved_at === null ? null : Number(row.resolved_at),
        })),
      });
    });

    app.post(`${API_PREFIX}/staff/anomalies/:id/resolve`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffAnomalies);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(resolveAnomalyBody, request.body ?? {});

      const anomaly = await db.selectFrom("anomalies").selectAll().where("id", "=", id).executeTakeFirst();
      if (!anomaly) throw notFound("anomaly_not_found", "异常不存在");

      const now = Date.now();
      const userId = Number(anomaly.user_id);

      if (body.action === "freeze") {
        const days = body.days ?? 7;
        await db
          .updateTable("users")
          .set({ bonus_frozen_until: now + days * 86_400_000 })
          .where("id", "=", userId)
          .execute();
      } else if (body.action === "ban") {
        await db.updateTable("users").set({ status: "banned" }).where("id", "=", userId).execute();
        await deleteAllSessionsOfUser(db, userId);
      }

      await db
        .updateTable("anomalies")
        .set({
          status: body.action === "dismiss" ? "dismissed" : "resolved",
          resolved_by: Number(auth.user.id),
          resolved_at: now,
        })
        .where("id", "=", id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: `anomaly.${body.action}`,
          target_type: "anomaly",
          target_id: String(id),
          detail_json: JSON.stringify({ days: body.days ?? null, reason: body.reason ?? null }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      await createNotification(db, {
        userId,
        kind: "account",
        title: "反作弊处理结果",
        body:
          body.action === "freeze"
            ? `你的收益已被冻结 ${String(body.days ?? 7)} 天，可在申诉页说明情况。`
            : body.action === "ban"
              ? "你的账号因异常行为被封禁，可通过免登录申诉入口提交申诉。"
              : "一条异常记录已处理。",
        linkUrl: "/appeals",
      });

      return staffActionResponse.parse({
        ok: true,
        status: body.action,
        message:
          body.action === "freeze"
            ? "已冻结收益"
            : body.action === "ban"
              ? "已封禁关联用户"
              : "已处理异常",
      });
    });

    app.get(`${API_PREFIX}/staff/audit`, async (request) => {
      requirePerm(request, PERMISSIONS.staffAudit);
      const rows = await db
        .selectFrom("audit_logs as a")
        .leftJoin("users as u", "u.id", "a.actor_id")
        .select([
          "a.id as id",
          "a.action as action",
          "a.target_type as target_type",
          "a.target_id as target_id",
          "a.detail_json as detail_json",
          "a.ip as ip",
          "a.created_at as created_at",
          "u.username as actor",
        ])
        .orderBy("a.created_at", "desc")
        .limit(200)
        .execute();

      return auditResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          actor: row.actor,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          detail: row.detail_json,
          ip: row.ip,
          created_at: Number(row.created_at),
        })),
      });
    });

    app.get(`${API_PREFIX}/staff/audit/export`, async (request, reply) => {
      requirePerm(request, PERMISSIONS.staffAudit);
      const rows = await db
        .selectFrom("audit_logs as a")
        .leftJoin("users as u", "u.id", "a.actor_id")
        .select([
          "a.id as id",
          "a.action as action",
          "a.target_type as target_type",
          "a.target_id as target_id",
          "a.detail_json as detail_json",
          "a.ip as ip",
          "a.created_at as created_at",
          "u.username as actor",
        ])
        .orderBy("a.created_at", "desc")
        .limit(5000)
        .execute();

      const header = "id,created_at,actor,action,target_type,target_id,ip,detail\n";
      const body = rows
        .map((row) =>
          [
            String(row.id),
            new Date(Number(row.created_at)).toISOString(),
            row.actor ?? "",
            row.action,
            row.target_type ?? "",
            row.target_id ?? "",
            row.ip ?? "",
            row.detail_json ?? "",
          ]
            .map(csvEscape)
            .join(","),
        )
        .join("\n");

      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="audit-log.csv"');
      reply.header("cache-control", "no-store");
      return reply.send(header + body);
    });

    app.get(`${API_PREFIX}/staff/appeals`, async (request) => {
      requirePerm(request, PERMISSIONS.staffAppeals);
      const query = request.query as { status?: string };
      const items: AppealItem[] = await loadAppeals(db, {
        ...(query.status ? { status: query.status } : {}),
        limit: 100,
      });
      return appealsResponse.parse({ items });
    });

    app.post(`${API_PREFIX}/staff/appeals/:id/resolve`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffAppeals);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(appealResolveBody, request.body ?? {});

      const appeal = await db.selectFrom("appeals").selectAll().where("id", "=", id).executeTakeFirst();
      if (!appeal) throw notFound("appeal_not_found", "申诉不存在");
      if (appeal.status !== "open") throw conflict("appeal_not_open", "申诉已处理");

      const now = Date.now();
      const userId = Number(appeal.user_id);

      if (body.action === "accept") {
        if (appeal.kind === "ban") {
          await db.updateTable("users").set({ status: "active" }).where("id", "=", userId).execute();
        } else if (appeal.kind === "bonus_freeze") {
          await db.updateTable("users").set({ bonus_frozen_until: null }).where("id", "=", userId).execute();
        }
      }

      await db
        .updateTable("appeals")
        .set({
          status: body.action === "accept" ? "accepted" : "rejected",
          resolved_by: Number(auth.user.id),
          resolved_at: now,
          resolution_note: body.note ?? null,
        })
        .where("id", "=", id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: `appeal.${body.action}`,
          target_type: "appeal",
          target_id: String(id),
          detail_json: JSON.stringify({ note: body.note ?? null }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      await createNotification(db, {
        userId,
        kind: "appeal",
        title: body.action === "accept" ? "申诉已通过" : "申诉被驳回",
        body:
          body.action === "accept"
            ? `你的申诉已通过${appeal.kind === "ban" ? "，账号已恢复" : appeal.kind === "bonus_freeze" ? "，收益冻结已解除" : ""}。`
            : `你的申诉被驳回：${body.note ?? "请补充更完整的说明。"}`,
        linkUrl: "/appeals",
      });

      return staffActionResponse.parse({
        ok: true,
        status: body.action,
        message: body.action === "accept" ? "申诉已通过" : "申诉已驳回",
      });
    });
  };
}
