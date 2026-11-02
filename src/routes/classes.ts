import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  API_PREFIX,
  PERMISSIONS,
  classGrantBody,
  classHistoryResponse,
  classNotificationTemplates,
  classRecalcResponse,
  classRulesSettings,
  classSchedulerResponse,
  classSimulationRequest,
  classSimulationResponse,
  classSimulationSearchResponse,
  classRunsResponse,
  classesResponse,
  createClassBody,
  updateClassBody,
  updateClassSchedulerBody,
  userPermissionOverridesBody,
  userPermissionOverridesResponse,
  staffActionResponse,
  type ClassItem,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import type { Selectable } from "kysely";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import {
  classBriefOf,
  classPermissionError,
  isAutoPromote,
  loadAllClasses,
  loadClassById,
  loadClassBySlug,
  parsePermissions,
  parseRule,
  toClassBrief,
  type ClassRow,
} from "../lib/classes.js";
import {
  buildMetrics,
  evaluateUserClass,
  type RecalcUser,
  type UserClassContext,
} from "../lib/class-decision.js";
import { loadClassRules, runClassRecalc, saveClassRules } from "../lib/class-recalc.js";
import { loadClassTemplates, notifyClassChange, saveClassTemplates } from "../lib/class-notifications.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";
import { settingsSchema } from "@kyokkou/config";
import { loadSettings } from "../lib/settings.js";
import { nextRunAt, reloadSchedulers } from "../lib/scheduler.js";

function requirePerm(request: FastifyRequest, permission: string) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(permission)) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

async function saveClassesSetting(db: Db, value: unknown): Promise<void> {
  const now = Date.now();
  const updated = await db
    .updateTable("site_settings")
    .set({ value_json: JSON.stringify(value), updated_at: now })
    .where("key", "=", "classes")
    .execute();
  if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
    await db
      .insertInto("site_settings")
      .values({ key: "classes", value_json: JSON.stringify(value), updated_at: now })
      .execute();
  }
}

function classItem(row: ClassRow, memberCount?: number): ClassItem {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    rank: Number(row.rank),
    badge: row.badge,
    color: row.color,
    description: row.description,
    permissions: parsePermissions(row.permissions_json),
    invite_quota: Number(row.invite_quota),
    auto_approve_quota: Number(row.auto_approve_quota),
    promote_rule: parseRule(row.promote_rule_json),
    demote_rule: parseRule(row.demote_rule_json),
    promote_grace_days: Number(row.promote_grace_days),
    demote_grace_days: Number(row.demote_grace_days),
    lock_manual: Number(row.lock_manual) === 1,
    manual_grantable: Number(row.manual_grantable) === 1,
    visible: Number(row.visible) === 1,
    exempt_hr: Number(row.exempt_hr) === 1,
    exempt_ratio_matrix: Number(row.exempt_ratio_matrix) === 1,
    ...(memberCount === undefined ? {} : { member_count: memberCount }),
  };
}

function operatorRank(request: FastifyRequest): number {
  const auth = requireAuth(request);
  return auth.class ? Number(auth.class.rank) : 0;
}

function ensureBelowOperator(request: FastifyRequest, rank: number): void {
  if (rank >= operatorRank(request)) {
    throw new HttpProblem(403, "rank_too_high", "只能管理等级低于自己的等级");
  }
}

async function memberCounts(db: Db): Promise<Map<number, number>> {
  const rows = await db
    .selectFrom("users")
    .select("class_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .groupBy("class_id")
    .execute();
  return new Map(
    rows
      .filter((row) => row.class_id !== null)
      .map((row) => [Number(row.class_id), Number(row.count)]),
  );
}

async function loadSimulationContext(
  db: Db,
  userId: number,
): Promise<{ ctx: UserClassContext; user: RecalcUser; now: number }> {
  const row = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
  if (!row) throw notFound("user_not_found", "用户不存在");

  const now = Date.now();
  const [published, invites, hnr, classes, rules] = await Promise.all([
    db
      .selectFrom("torrents")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("uploader_id", "=", userId)
      .where("status", "=", "approved")
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("invites")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("inviter_id", "=", userId)
      .where("status", "=", "used")
      .executeTakeFirst(),
    db
      .selectFrom("hnr_obligations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", userId)
      .where("status", "not in", ["reached", "cleared"])
      .executeTakeFirst(),
    loadAllClasses(db),
    loadClassRules(db),
  ]);

  const user: RecalcUser = {
    id: Number(row.id),
    username: row.username,
    class_id: row.class_id === null ? null : Number(row.class_id),
    created_at: Number(row.created_at),
    last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
    uploaded: Number(row.uploaded),
    downloaded: Number(row.downloaded),
    raw_uploaded: Number(row.raw_uploaded ?? 0),
    raw_downloaded: Number(row.raw_downloaded ?? 0),
    bonus: Number(row.bonus),
    seedtime: Number(row.seedtime),
    warnings: Number(row.warnings ?? 0),
    class_locked_until: row.class_locked_until === null ? null : Number(row.class_locked_until),
    demote_due_at: row.demote_due_at === null ? null : Number(row.demote_due_at),
  };

  const metrics = buildMetrics(user, now, {
    published: Number(published?.count ?? 0),
    invitesUsed: Number(invites?.count ?? 0),
    hnrUnfinished: Number(hnr?.count ?? 0),
  });

  const ctx: UserClassContext = {
    metrics,
    classes,
    classById: new Map(classes.map((entry) => [Number(entry.id), entry])),
    classBySlug: new Map(classes.map((entry) => [entry.slug, entry])),
    rules,
  };

  return { ctx, user, now };
}

export function classRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/classes`, async () => {
      const rows = await loadAllClasses(db);
      return classesResponse.parse({
        items: rows
          .filter((row) => Number(row.visible) === 1)
          .map((row) => {
            const item = classItem(row);
            return { ...item, permissions: item.permissions.filter((p) => !p.startsWith("staff.")) };
          }),
      });
    });

    app.get(`${API_PREFIX}/staff/classes`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClasses);
      const [rows, counts] = await Promise.all([loadAllClasses(db), memberCounts(db)]);
      return classesResponse.parse({
        items: rows.map((row) => classItem(row, counts.get(Number(row.id)) ?? 0)),
      });
    });

    // 用户管理需要包含 hidden 等级（管理组等），但只要求 staff.users。
    app.get(`${API_PREFIX}/staff/users/classes`, async (request) => {
      requirePerm(request, PERMISSIONS.staffUsers);
      const rows = await loadAllClasses(db);
      return classesResponse.parse({ items: rows.map((row) => classItem(row)) });
    });

    app.post(`${API_PREFIX}/staff/classes`, async (request, reply) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(createClassBody, request.body ?? {});
      const rows = await loadAllClasses(db);
      if (rows.some((row) => row.slug === body.slug)) {
        throw conflict("class_exists", "等级标识已存在");
      }

      const rank = body.rank ?? Math.max(0, ...rows.map((row) => Number(row.rank))) + 1;
      ensureBelowOperator(request, rank);

      const permissions = [...new Set(body.permissions)];
      const permissionError = classPermissionError(permissions);
      if (permissionError) throw badRequest("invalid_permissions", permissionError);

      const now = Date.now();
      await db
        .insertInto("classes")
        .values({
          slug: body.slug,
          name: body.name,
          rank,
          badge: body.badge ?? null,
          color: body.color ?? null,
          description: body.description,
          permissions_json: JSON.stringify(permissions),
          invite_quota: body.invite_quota,
          auto_approve_quota: body.auto_approve_quota,
          promote_rule_json: body.promote_rule ? JSON.stringify(body.promote_rule) : null,
          demote_rule_json: body.demote_rule ? JSON.stringify(body.demote_rule) : null,
          promote_grace_days: body.promote_grace_days,
          demote_grace_days: body.demote_grace_days,
          lock_manual: body.lock_manual ? 1 : 0,
          manual_grantable: body.manual_grantable ? 1 : 0,
          visible: body.visible ? 1 : 0,
          exempt_hr: body.exempt_hr ? 1 : 0,
          exempt_ratio_matrix: body.exempt_ratio_matrix ? 1 : 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "class.create",
          target_type: "class",
          target_id: body.slug,
          detail_json: JSON.stringify({ rank, permissions }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      return reply.status(201).send(
        staffActionResponse.parse({ ok: true, status: "created", message: `已创建等级「${body.name}」` }),
      );
    });

    app.put(`${API_PREFIX}/staff/classes/:slug`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const slug = (request.params as { slug: string }).slug;
      const existing = await loadClassBySlug(db, slug);
      if (!existing) throw notFound("class_not_found", "等级不存在");
      ensureBelowOperator(request, Number(existing.rank));

      const body = parseOrThrow(updateClassBody, request.body ?? {});
      const now = Date.now();
      const permissions = body.permissions ? [...new Set(body.permissions)] : undefined;
      if (permissions) {
        const permissionError = classPermissionError(permissions);
        if (permissionError) throw badRequest("invalid_permissions", permissionError);
      }
      if (body.rank !== undefined) ensureBelowOperator(request, body.rank);

      await db
        .updateTable("classes")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.rank === undefined ? {} : { rank: body.rank }),
          ...(body.badge === undefined ? {} : { badge: body.badge }),
          ...(body.color === undefined ? {} : { color: body.color }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(permissions === undefined ? {} : { permissions_json: JSON.stringify(permissions) }),
          ...(body.invite_quota === undefined ? {} : { invite_quota: body.invite_quota }),
          ...(body.auto_approve_quota === undefined ? {} : { auto_approve_quota: body.auto_approve_quota }),
          ...(body.promote_rule === undefined
            ? {}
            : { promote_rule_json: body.promote_rule ? JSON.stringify(body.promote_rule) : null }),
          ...(body.demote_rule === undefined
            ? {}
            : { demote_rule_json: body.demote_rule ? JSON.stringify(body.demote_rule) : null }),
          ...(body.promote_grace_days === undefined ? {} : { promote_grace_days: body.promote_grace_days }),
          ...(body.demote_grace_days === undefined ? {} : { demote_grace_days: body.demote_grace_days }),
          ...(body.lock_manual === undefined ? {} : { lock_manual: body.lock_manual ? 1 : 0 }),
          ...(body.manual_grantable === undefined ? {} : { manual_grantable: body.manual_grantable ? 1 : 0 }),
          ...(body.visible === undefined ? {} : { visible: body.visible ? 1 : 0 }),
          ...(body.exempt_hr === undefined ? {} : { exempt_hr: body.exempt_hr ? 1 : 0 }),
          ...(body.exempt_ratio_matrix === undefined
            ? {}
            : { exempt_ratio_matrix: body.exempt_ratio_matrix ? 1 : 0 }),
          updated_at: now,
        })
        .where("id", "=", existing.id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "class.update",
          target_type: "class",
          target_id: slug,
          detail_json: JSON.stringify({ fields: Object.keys(body) }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      return staffActionResponse.parse({ ok: true, status: "updated", message: "已保存等级" });
    });

    app.delete(`${API_PREFIX}/staff/classes/:slug`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const slug = (request.params as { slug: string }).slug;
      const existing = await loadClassBySlug(db, slug);
      if (!existing) throw notFound("class_not_found", "等级不存在");
      ensureBelowOperator(request, Number(existing.rank));
      if (slug === "user") throw badRequest("fallback_class", "默认等级不能删除");

      const used = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("class_id", "=", Number(existing.id))
        .executeTakeFirst();
      if (Number(used?.count ?? 0) > 0) {
        throw conflict("class_in_use", "仍有用户属于该等级，不能删除");
      }

      if (parsePermissions(existing.permissions_json).includes(PERMISSIONS.staffAvailable)) {
        const rows = await loadAllClasses(db);
        const staffClasses = rows.filter((row) =>
          parsePermissions(row.permissions_json).includes(PERMISSIONS.staffAvailable),
        );
        if (staffClasses.length <= 1) {
          throw conflict("last_staff_class", "不能删除最后一个管理等级");
        }
      }

      await db.deleteFrom("classes").where("id", "=", existing.id).execute();
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "class.delete",
          target_type: "class",
          target_id: slug,
          detail_json: null,
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();
      return staffActionResponse.parse({ ok: true, status: "deleted", message: `已删除等级 ${slug}` });
    });

    app.get(`${API_PREFIX}/staff/classes/rules`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClasses);
      return classRulesSettings.parse(await loadClassRules(db));
    });

    app.put(`${API_PREFIX}/staff/classes/rules`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(classRulesSettings, request.body ?? {});
      const matrix = body.ratio_matrix
        .slice()
        .sort((a, b) => a.download_gb - b.download_gb);
      const matrixTarget = await loadClassBySlug(db, body.matrix_target_slug);
      if (!matrixTarget) throw badRequest("class_not_found", "分享率矩阵目标等级不存在");
      await saveClassRules(db, {
        matrix_enabled: body.matrix_enabled,
        ratio_matrix: matrix,
        matrix_target_slug: matrixTarget.slug,
      });
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "class.rules_update",
          target_type: "class",
          target_id: "rules",
          detail_json: JSON.stringify({
            matrix_enabled: body.matrix_enabled,
            rows: matrix.length,
            matrix_target_slug: matrixTarget.slug,
          }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();
      return classRulesSettings.parse({
        matrix_enabled: body.matrix_enabled,
        ratio_matrix: matrix,
        matrix_target_slug: matrixTarget.slug,
      });
    });

    app.get(`${API_PREFIX}/staff/classes/notifications`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClasses);
      return classNotificationTemplates.parse(await loadClassTemplates(db));
    });

    app.put(`${API_PREFIX}/staff/classes/notifications`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(classNotificationTemplates, request.body ?? {});
      await saveClassTemplates(db, body);
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "class.notifications_update",
          target_type: "class",
          target_id: "notifications",
          detail_json: null,
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();
      return classNotificationTemplates.parse(body);
    });

    // 模拟器：与自动重算共用同一套判定，只读不写库（staff.class_simulate）。
    app.get(`${API_PREFIX}/staff/classes/simulate/search`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClassSimulate);
      const query = request.query as { q?: string };
      const needle = query.q?.trim().toLowerCase() ?? "";
      let builder = db
        .selectFrom("users as u")
        .leftJoin("classes as c", "c.id", "u.class_id")
        .select(["u.id as id", "u.username as username", "c.slug as slug", "c.name as name", "c.rank as rank", "c.badge as badge", "c.color as color"])
        .orderBy("u.id", "asc")
        .limit(10);
      if (needle.length > 0) {
        builder = builder.where("u.username", "like", `%${needle}%` as never);
      }
      const rows = await builder.execute();
      return classSimulationSearchResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          username: row.username,
          class: {
            slug: row.slug ?? "unknown",
            name: row.name ?? "未知等级",
            rank: Number(row.rank ?? 0),
            badge: row.badge ?? null,
            color: row.color ?? null,
          },
        })),
      });
    });

    app.post(`${API_PREFIX}/staff/classes/simulate`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClassSimulate);
      const body = parseOrThrow(classSimulationRequest, request.body ?? {});
      const { ctx, user, now } = await loadSimulationContext(db, body.user_id);
      const decision = await evaluateUserClass(db, user, ctx, now);
      const current = decision.current;
      if (!current) throw badRequest("class_missing", "用户没有有效等级");

      return classSimulationResponse.parse({
        user_id: body.user_id,
        username: user.username,
        current: toClassBrief(current),
        target: decision.target ? toClassBrief(decision.target) : decision.finalTarget ? toClassBrief(decision.finalTarget) : null,
        action: decision.action,
        path: decision.path.map((row) => toClassBrief(row)),
        missing: decision.missing,
        demote_reason: decision.demoteReason,
        blocked_reason: decision.blockedReason,
        locked_until: user.class_locked_until,
        demote_due_at: decision.demoteDueAt,
        metrics: {
          ...ctx.metrics,
          ratio: Number.isFinite(ctx.metrics.ratio) ? ctx.metrics.ratio : null,
        },
      });
    });

    // 等级变更历史（staff.class_history），支持按用户过滤与游标分页。
    app.get(`${API_PREFIX}/staff/classes/history`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClassHistory);
      const query = request.query as { user_id?: string; cursor?: string; limit?: string };
      const limit = Math.min(Math.max(Number(query.limit ?? 30) || 30, 1), 100);

      let builder = db
        .selectFrom("user_class_history as h")
        .leftJoin("users as u", "u.id", "h.user_id")
        .leftJoin("classes as fc", "fc.id", "h.from_class_id")
        .leftJoin("classes as tc", "tc.id", "h.to_class_id")
        .leftJoin("users as actor", "actor.id", "h.actor_id")
        .select([
          "h.id as id",
          "h.user_id as user_id",
          "u.username as username",
          "fc.name as from_class",
          "tc.name as to_class",
          "h.source as source",
          "h.reason as reason",
          "actor.username as actor",
          "h.created_at as created_at",
        ])
        .orderBy("h.id", "desc")
        .limit(limit + 1);

      if (query.user_id && Number(query.user_id) > 0) {
        builder = builder.where("h.user_id", "=", Number(query.user_id));
      }
      if (query.cursor && Number(query.cursor) > 0) {
        builder = builder.where("h.id", "<", Number(query.cursor));
      }

      const rows = await builder.execute();
      const page = rows.slice(0, limit);
      return classHistoryResponse.parse({
        items: page.map((row) => ({
          id: Number(row.id),
          user_id: Number(row.user_id),
          username: row.username ?? null,
          from_class: row.from_class ?? null,
          to_class: row.to_class ?? "—",
          source: row.source,
          reason: row.reason,
          actor: row.actor ?? null,
          created_at: Number(row.created_at),
        })),
        next_cursor: rows.length > limit ? Number(page[page.length - 1]?.id ?? 0) : null,
      });
    });

    app.get(`${API_PREFIX}/staff/classes/scheduler`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      const settings = await loadSettings(db);
      return classSchedulerResponse.parse({
        settings: {
          recalc_enabled: settings.classes.recalc_enabled,
          recalc_cron: settings.classes.recalc_cron,
          next_run_at: settings.classes.recalc_enabled
            ? nextRunAt(settings.classes.recalc_cron)
            : null,
        },
      });
    });

    app.put(`${API_PREFIX}/staff/classes/scheduler`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(updateClassSchedulerBody, request.body ?? {});
      const current = await loadSettings(db);
      const merged = settingsSchema.parse({
        ...current,
        classes: {
          ...current.classes,
          ...body,
        },
      });
      const next = nextRunAt(merged.classes.recalc_cron);
      if (next === null) {
        throw new HttpProblem(400, "invalid_cron", "cron 表达式无效或间隔小于 5 分钟");
      }
      await saveClassesSetting(db, merged.classes);
      await reloadSchedulers(db);
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "classes.scheduler.update",
          target_type: "settings",
          target_id: "classes",
          detail_json: JSON.stringify({ recalc_enabled: merged.classes.recalc_enabled }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();
      return classSchedulerResponse.parse({
        settings: {
          recalc_enabled: merged.classes.recalc_enabled,
          recalc_cron: merged.classes.recalc_cron,
          next_run_at: merged.classes.recalc_enabled ? next : null,
        },
      });
    });

    app.post(`${API_PREFIX}/staff/classes/recalc`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffClasses);
      assertCsrf(request, auth.session);
      const result = await runClassRecalc(db, {
        triggeredBy: "manual",
        actorId: Number(auth.user.id),
      });
      return classRecalcResponse.parse({ ok: true, ...result });
    });

    app.get(`${API_PREFIX}/staff/classes/runs`, async (request) => {
      requirePerm(request, PERMISSIONS.staffClasses);
      const rows = await db
        .selectFrom("class_recalc_runs")
        .selectAll()
        .orderBy("id", "desc")
        .limit(20)
        .execute();
      return classRunsResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          started_at: Number(row.started_at),
          finished_at: row.finished_at === null ? null : Number(row.finished_at),
          scanned: Number(row.scanned),
          promoted: Number(row.promoted),
          demoted: Number(row.demoted),
          error: row.error,
          triggered_by: row.triggered_by,
        })),
      });
    });

    app.put(`${API_PREFIX}/staff/users/:id/class`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffUserEditClass);
      assertCsrf(request, auth.session);
      const userId = Number((request.params as { id: string }).id);
      if (userId === Number(auth.user.id)) throw badRequest("self_class", "不能修改自己的等级");
      const body = parseOrThrow(classGrantBody, request.body ?? {});
      const targetUser = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
      if (!targetUser) throw notFound("user_not_found", "用户不存在");
      const toClass = await loadClassBySlug(db, body.class_slug);
      if (!toClass) throw badRequest("class_not_found", "等级不存在");
      if (Number(toClass.manual_grantable) === 0) throw badRequest("class_not_grantable", "该等级不允许手动授予");
      ensureBelowOperator(request, Number(toClass.rank));

      const fromClass =
        targetUser.class_id === null ? null : await loadClassById(db, Number(targetUser.class_id));
      const fromRank = fromClass ? Number(fromClass.rank) : 0;

      const now = Date.now();
      const lock = body.lock === true;
      const expires = body.expires_at ?? (lock ? now + 3650 * 86_400_000 : null);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("users")
          .set({
            class_id: Number(toClass.id),
            class_key: toClass.slug,
            class_locked_until: expires,
            demote_due_at: null,
            max_class_once: Math.max(Number(targetUser.max_class_once ?? 1), Number(toClass.id)),
          })
          .where("id", "=", userId)
          .execute();
        await trx
          .insertInto("user_class_history")
          .values({
            user_id: userId,
            from_class_id: fromClass ? Number(fromClass.id) : null,
            to_class_id: Number(toClass.id),
            source: "manual",
            reason: "手动调整等级",
            detail_json: JSON.stringify({ from: fromClass?.slug ?? null, to: toClass.slug }),
            actor_id: Number(auth.user.id),
            created_at: now,
          })
          .execute();
        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "class.set",
            target_type: "user",
            target_id: String(userId),
            detail_json: JSON.stringify({ from: fromClass?.slug ?? null, to: toClass.slug, lock }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      await notifyClassChange(db, {
        userId,
        kind: Number(toClass.rank) > fromRank ? "promote" : "demote",
        oldName: fromClass?.name ?? "—",
        newName: toClass.name,
        reason: "由 Staff 手动调整",
      });

      return staffActionResponse.parse({ ok: true, status: "updated", message: `已将等级设为「${toClass.name}」` });
    });

    app.put(`${API_PREFIX}/staff/users/:id/permissions`, async (request) => {
      const auth = requirePerm(request, PERMISSIONS.staffUserEditClass);
      assertCsrf(request, auth.session);
      const userId = Number((request.params as { id: string }).id);
      if (userId === Number(auth.user.id)) throw badRequest("self_permissions", "不能修改自己的权限");
      const user = await db.selectFrom("users").select("id").where("id", "=", userId).executeTakeFirst();
      if (!user) throw notFound("user_not_found", "用户不存在");
      const body = parseOrThrow(userPermissionOverridesBody, request.body ?? {});

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom("user_permission_overrides").where("user_id", "=", userId).execute();
        const rows = [
          ...body.extra.map((permission) => ({ effect: "grant" as const, permission })),
          ...body.denied.map((permission) => ({ effect: "deny" as const, permission })),
        ];
        for (const row of rows) {
          await trx
            .insertInto("user_permission_overrides")
            .values({
              user_id: userId,
              permission: row.permission,
              effect: row.effect,
              expires_at: body.expires_at ?? null,
              actor_id: Number(auth.user.id),
              created_at: now,
            })
            .execute();
        }
        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "class.permissions_update",
            target_type: "user",
            target_id: String(userId),
            detail_json: JSON.stringify({ extra: body.extra, denied: body.denied }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      return userPermissionOverridesResponse.parse({
        extra: body.extra,
        denied: body.denied,
        expires_at: body.expires_at ?? null,
      });
    });
  };
}
