import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { randomBytes } from "node:crypto";
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
  staffCreateUserBody,
  staffSummaryResponse,
  staffUpdateUserBody,
  staffUsersResponse,
  type AppealItem,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { currentSchemaVersion } from "../db/migrate.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { hashPassword } from "../auth/password.js";
import { classBriefOf, loadClassBySlug } from "../lib/classes.js";
import { deleteAllSessionsOfUser } from "../auth/session.js";
import { loadAppeals } from "../lib/appeals.js";
import { createNotification } from "../lib/notifications.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { hueFor, numberCount, ratioFor } from "../lib/serialize.js";
import { parseOrThrow } from "../lib/validate.js";
import { normalizeUsername, validateUsername } from "../lib/username.js";

const USER_EDIT_FIELD_PERMISSIONS: Record<string, string> = {
  username: PERMISSIONS.staffUserEditUsername,
  email: PERMISSIONS.staffUserEditEmail,
  password: PERMISSIONS.staffUserEditPassword,
  class_slug: PERMISSIONS.staffUserEditClass,
  class_key: PERMISSIONS.staffUserEditClass,
  status: PERMISSIONS.staffUserEditStatus,
  bonus: PERMISSIONS.staffUserEditBonus,
  uploaded: PERMISSIONS.staffUserEditUploaded,
  downloaded: PERMISSIONS.staffUserEditDownloaded,
  invite_balance: PERMISSIONS.staffUserEditInviteBalance,
  warnings: PERMISSIONS.staffUserEditWarnings,
  custom_title: PERMISSIONS.staffUserEditCustomTitle,
};

function assertUserEditFields(
  auth: ReturnType<typeof requirePerm>,
  body: Record<string, unknown>,
): void {
  for (const [field, permission] of Object.entries(USER_EDIT_FIELD_PERMISSIONS)) {
    if (body[field] !== undefined && !auth.permissions.includes(permission)) {
      throw new HttpProblem(403, "forbidden_field", `没有修改 ${field} 的权限`);
    }
  }
}

function requirePerm(request: FastifyRequest, permission: string) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(permission)) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

/** 操作者只能授予/调整 rank 不高于自己的等级。 */
function assertRankAtOrBelowOperator(
  auth: ReturnType<typeof requirePerm>,
  targetRank: number,
): void {
  const operatorRank = auth.class ? Number(auth.class.rank) : 0;
  if (targetRank > operatorRank) {
    throw new HttpProblem(403, "rank_too_high", "只能操作等级不高于自己的用户等级");
  }
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
      const classRows = await db.selectFrom("classes").selectAll().execute();
      const classById = new Map(classRows.map((row) => [Number(row.id), row]));

      return staffUsersResponse.parse({
        items: rows.map((user) => {
          const classRow =
            user.class_id === null ? null : (classById.get(Number(user.class_id)) ?? null);
          return {
            id: Number(user.id),
            username: user.username,
            email: user.email,
            role: user.role,
            class_key: classRow?.slug ?? user.class_key,
            class: classBriefOf(classRow, user.class_key, user.class_key),
            warnings: Number(user.warnings ?? 0),
            invite_balance: Number(user.invite_balance ?? 0),
            custom_title: user.custom_title ?? null,
            status: user.status,
            uploaded: Number(user.uploaded),
            downloaded: Number(user.downloaded),
            raw_uploaded: Number(user.raw_uploaded ?? 0),
            raw_downloaded: Number(user.raw_downloaded ?? 0),
            ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
            bonus: Number(user.bonus),
            created_at: Number(user.created_at),
            last_seen_at: user.last_seen_at === null ? null : Number(user.last_seen_at),
          };
        }),
      });
    });

    app.post(`${API_PREFIX}/staff/users`, async (request, reply) => {
      const auth = requirePerm(request, PERMISSIONS.staffUsers);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffCreateUserBody, request.body ?? {});

      const checkedUsername = validateUsername(body.username, {
        allowAdmin: auth.permissions.includes(PERMISSIONS.staffUserEditUsername),
      });
      if (!checkedUsername.ok) throw badRequest(checkedUsername.code, checkedUsername.message);
      const username = checkedUsername.username;
      const email = body.email.trim().toLowerCase();
      const existing = await db
        .selectFrom("users")
        .select("id")
        .where((eb) => eb.or([eb("username", "=", username), eb("email", "=", email)]))
        .executeTakeFirst();
      if (existing) throw conflict("account_exists", "用户名或邮箱已被使用");

      const classSlug = body.class_slug?.trim() || body.class_key?.trim() || "user";
      const targetClass = await loadClassBySlug(db, classSlug);
      if (!targetClass) throw badRequest("class_not_found", "等级不存在");
      assertRankAtOrBelowOperator(auth, Number(targetClass.rank));

      const now = Date.now();
      const passwordHash = await hashPassword(body.password);
      const passkey = randomBytes(16).toString("hex");

      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("users")
          .values({
            username,
            email,
            password_hash: passwordHash,
            passkey,
            role: body.role ?? "user",
            class_key: targetClass.slug,
            class_id: Number(targetClass.id),
            warnings: 0,
            raw_uploaded: 0,
            raw_downloaded: 0,
            invite_balance: Number(targetClass.invite_quota),
            class_locked_until: null,
            demote_due_at: null,
            status: "active",
            uploaded: 0,
            downloaded: 0,
            bonus: 0,
            seedtime: 0,
            invited_by: null,
            created_at: now,
            last_seen_at: null,
            bonus_frozen_until: null,
            last_bonus_at: now,
          })
          .execute();

        const created = await trx
          .selectFrom("users")
          .select("id")
          .where("username", "=", username)
          .executeTakeFirstOrThrow();

        await trx
          .insertInto("user_preferences")
          .values({
            user_id: Number(created.id),
            email_review: 1,
            email_hnr: 1,
            email_invite: 1,
            email_social: 0,
            email_weekly: 0,
            public_seeding: 1,
            public_published: 1,
            searchable: 1,
            updated_at: now,
          })
          .execute();

        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "user.create",
            target_type: "user",
            target_id: String(created.id),
            detail_json: JSON.stringify({ class: targetClass.slug }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      return reply.status(201).send(
        staffActionResponse.parse({
          ok: true,
          status: "created",
          message: `已创建用户 ${username}`,
        }),
      );
    });

    app.put(`${API_PREFIX}/staff/users/:id`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffUsers);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(staffUpdateUserBody, request.body ?? {});

      const target = await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
      if (!target) throw notFound("user_not_found", "用户不存在");
      assertUserEditFields(auth, body as unknown as Record<string, unknown>);

      const self = Number(target.id) === Number(auth.user.id);
      if (self && body.role && body.role !== target.role) {
        throw badRequest("self_role", "不能修改自己的角色");
      }
      if (self && body.status && body.status !== target.status) {
        throw badRequest("self_status", "不能修改自己的状态");
      }

      const patch: Record<string, unknown> = {};
      let usernameChange: { old: string; next: string } | null = null;
      if (body.username !== undefined) {
        const checkedUsername = validateUsername(body.username, { allowAdmin: true });
        if (!checkedUsername.ok) throw badRequest(checkedUsername.code, checkedUsername.message);
        if (checkedUsername.username !== target.username) {
          const exists = await db
            .selectFrom("users")
            .select("id")
            .where("username", "=", checkedUsername.username)
            .where("id", "!=", id)
            .executeTakeFirst();
          if (exists) throw conflict("username_taken", "用户名已被使用");
          patch.username = checkedUsername.username;
          patch.username_changed_at = Date.now();
          usernameChange = { old: target.username, next: checkedUsername.username };
        }
      }
      let newClass: Awaited<ReturnType<typeof loadClassBySlug>> = null;
      const classSlug = body.class_slug?.trim() || body.class_key?.trim();
      if (classSlug) {
        newClass = await loadClassBySlug(db, classSlug);
        if (!newClass) throw badRequest("class_not_found", "等级不存在");
        if (Number(newClass.manual_grantable) === 0) {
          throw badRequest("class_not_grantable", "该等级不允许手动授予");
        }
        assertRankAtOrBelowOperator(auth, Number(newClass.rank));
        patch.class_id = Number(newClass.id);
        patch.class_key = newClass.slug;
        // 手动调整后从当前等级重新开始观察；下一次重算可以正常升降。
        patch.demote_due_at = null;
      }
      if (body.email) {
        const email = body.email.trim().toLowerCase();
        const exists = await db
          .selectFrom("users")
          .select("id")
          .where("email", "=", email)
          .where("id", "!=", id)
          .executeTakeFirst();
        if (exists) throw conflict("email_taken", "邮箱已被使用");
        patch.email = email;
      }
      if (body.status) patch.status = body.status;
      if (body.password) patch.password_hash = await hashPassword(body.password);
      if (body.uploaded !== undefined) patch.uploaded = body.uploaded;
      if (body.downloaded !== undefined) patch.downloaded = body.downloaded;
      if (body.invite_balance !== undefined) patch.invite_balance = body.invite_balance;
      if (body.warnings !== undefined) patch.warnings = body.warnings;
      if (body.custom_title !== undefined) {
        const title = body.custom_title === null ? null : body.custom_title.trim();
        if (title !== null) {
          if (title.length < 1 || title.length > 64) {
            throw badRequest("invalid_title", "头衔长度需为 1–64");
          }
          if (/[\u0000-\u001f\u007f]/.test(title) || /\p{Extended_Pictographic}/u.test(title)) {
            throw badRequest("invalid_title", "头衔不能包含控制字符或 emoji");
          }
        }
        patch.custom_title = title;
      }
      let bonusDelta: number | null = null;
      if (body.bonus !== undefined) {
        patch.bonus = body.bonus;
        bonusDelta = body.bonus - Number(target.bonus);
      }

      if (Object.keys(patch).length === 0) {
        throw badRequest("nothing_to_update", "没有需要修改的内容");
      }

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("users").set(patch).where("id", "=", id).execute();
        if (bonusDelta !== null && bonusDelta !== 0 && body.bonus !== undefined) {
          await trx
            .insertInto("bonus_ledger")
            .values({
              user_id: id,
              kind: "adjust",
              delta: bonusDelta,
              balance_after: body.bonus,
              ref_type: "staff_adjust",
              ref_id: String(auth.user.id),
              note: `Staff 调整（${auth.user.username}）`,
              created_at: now,
            })
            .execute();
        }
        if (usernameChange) {
          await trx
            .insertInto("username_changes")
            .values({
              user_id: id,
              old_username: usernameChange.old,
              new_username: usernameChange.next,
              price: 0,
              refund_amount: 0,
              item_id: null,
              actor_id: Number(auth.user.id),
              created_at: now,
            })
            .execute();
          await trx
            .insertInto("audit_logs")
            .values({
              actor_id: Number(auth.user.id),
              action: "user.username_change",
              target_type: "user",
              target_id: String(id),
              detail_json: JSON.stringify(usernameChange),
              ip: request.ip,
              created_at: now,
            })
            .execute();
        }
        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "user.update",
            target_type: "user",
            target_id: String(id),
            detail_json: JSON.stringify({ fields: Object.keys(patch) }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      if (body.status === "suspended" || body.status === "banned" || body.password) {
        await deleteAllSessionsOfUser(db, id);
      }
      if (body.status && body.status !== target.status) {
        await createNotification(db, {
          userId: id,
          kind: "account",
          title: "账号状态变更",
          body:
            body.status === "active"
              ? "你的账号已恢复正常。"
              : body.status === "suspended"
                ? "你的账号已被停用。"
                : "你的账号已被封禁。",
          linkUrl: "/appeals",
        });
      }

      if (newClass && Number(newClass.id) !== Number(target.class_id ?? -1)) {
        await createNotification(db, {
          userId: id,
          kind: "account",
          title: "等级变更",
          body: `你的等级已调整为「${newClass.name}」。`,
          linkUrl: "/me",
        });
      }

      return staffActionResponse.parse({ ok: true, status: "updated", message: "已保存用户信息" });
    });

    app.delete(`${API_PREFIX}/staff/users/:id`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffUsers);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);

      if (id === Number(auth.user.id)) throw badRequest("self_delete", "不能删除自己");
      const target = await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
      if (!target) throw notFound("user_not_found", "用户不存在");

      const counts = await Promise.all([
        db.selectFrom("torrents").select((eb) => eb.fn.countAll<number>().as("count")).where("uploader_id", "=", id).executeTakeFirst(),
        db.selectFrom("snatches").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
        db.selectFrom("invites").select((eb) => eb.fn.countAll<number>().as("count")).where((eb) => eb.or([eb("inviter_id", "=", id), eb("invited_user_id", "=", id)])).executeTakeFirst(),
        db.selectFrom("requests").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
        db.selectFrom("bonus_ledger").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
        db.selectFrom("redemptions").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
        db.selectFrom("reports").select((eb) => eb.fn.countAll<number>().as("count")).where("reporter_id", "=", id).executeTakeFirst(),
        db.selectFrom("anomalies").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
        db.selectFrom("appeals").select((eb) => eb.fn.countAll<number>().as("count")).where("user_id", "=", id).executeTakeFirst(),
      ]);
      const total = counts.reduce((sum, row) => sum + Number(row?.count ?? 0), 0);
      if (total > 0) {
        throw conflict("user_has_data", "该用户仍有关联数据（种子/做种/邀请/账本等），请改用封禁");
      }

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom("sessions").where("user_id", "=", id).execute();
        await trx.deleteFrom("user_preferences").where("user_id", "=", id).execute();
        await trx.deleteFrom("twofa_recovery_codes").where("user_id", "=", id).execute();
        await trx.deleteFrom("notifications").where("user_id", "=", id).execute();
        await trx.deleteFrom("users").where("id", "=", id).execute();
        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "user.delete",
            target_type: "user",
            target_id: String(id),
            detail_json: JSON.stringify({ username: target.username }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      return staffActionResponse.parse({
        ok: true,
        status: "deleted",
        message: `已删除用户 ${target.username}`,
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
      if (action === "warn" && !auth.permissions.includes(PERMISSIONS.staffUserWarn)) {
        throw new HttpProblem(403, "forbidden", "没有警告权限");
      }
      if (action !== "warn" && !auth.permissions.includes(PERMISSIONS.staffUserEditStatus)) {
        throw new HttpProblem(403, "forbidden", "没有账号状态权限");
      }

      const now = Date.now();
      const nextStatus =
        action === "suspend" ? "suspended" : action === "ban" ? "banned" : action === "restore" ? "active" : target.status;

      await db
        .updateTable("users")
        .set({
          status: nextStatus,
          ...(action === "warn" ? { warnings: Number(target.warnings ?? 0) + 1 } : {}),
        })
        .where("id", "=", id)
        .execute();
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
