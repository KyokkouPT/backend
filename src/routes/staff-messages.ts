import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  API_PREFIX,
  PERMISSIONS,
  classRule,
  staffMessageBody,
  staffMessageOptions,
  staffMessagePreviewResponse,
  staffMessageSendResponse,
  type ClassRule,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { buildMetrics, type RecalcUser } from "../lib/class-decision.js";
import { evaluateRule } from "../lib/classes.js";
import { badRequest, forbidden } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";

const MESSAGE_KIND = "broadcast";
const SAMPLE_SIZE = 20;
const INSERT_CHUNK = 500;

function requireAnnouncement(request: FastifyRequest) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(PERMISSIONS.staffAnnouncement)) {
    throw forbidden("forbidden", "没有站内信群发权限");
  }
  return auth;
}

function normalizeLink(value: string | null | undefined): string | null {
  const link = value?.trim() || null;
  if (!link) return null;
  if (link.startsWith("//") || (!link.startsWith("/") && !/^https?:\/\//i.test(link))) {
    throw badRequest("invalid_link", "链接必须是站内路径或 http(s) 地址");
  }
  return link;
}

function validateConditions(rule: ClassRule | null | undefined): ClassRule | null {
  if (!rule || rule.conditions.length === 0) return null;
  const allowed = new Set([
    "age_days",
    "uploaded",
    "downloaded",
    "ratio",
    "seedtime_hours",
    "bonus",
    "torrents_published",
    "invites_used",
    "warnings",
    "hnr_unfinished",
    "last_active_days",
  ]);
  for (const condition of rule.conditions) {
    if (!allowed.has(condition.metric)) {
      throw badRequest("invalid_condition", `未知筛选指标：${condition.metric}`);
    }
  }
  return classRule.parse(rule);
}

async function resolveRecipients(db: Db, body: ReturnType<typeof staffMessageBody.parse>) {
  const classSlugs = [...new Set((body.class_slugs ?? []).map((slug) => slug.trim()).filter(Boolean))];
  const classRows =
    classSlugs.length > 0
      ? await db
          .selectFrom("classes")
          .select(["id", "slug"])
          .where("slug", "in", classSlugs)
          .execute()
      : [];
  const knownSlugs = new Set(classRows.map((row) => row.slug));
  const unknown = classSlugs.filter((slug) => !knownSlugs.has(slug));
  if (unknown.length > 0) throw badRequest("class_not_found", `等级不存在：${unknown.join(", ")}`);

  const userIds = [...new Set(body.user_ids ?? [])];
  const conditionRule = validateConditions(body.conditions);

  let query = db
    .selectFrom("users")
    .select([
      "id",
      "username",
      "class_id",
      "created_at",
      "last_seen_at",
      "uploaded",
      "downloaded",
      "raw_uploaded",
      "raw_downloaded",
      "bonus",
      "seedtime",
      "warnings",
      "class_locked_until",
      "demote_due_at",
    ])
    .where("status", "=", "active");

  if (userIds.length > 0) query = query.where("id", "in", userIds);
  if (classRows.length > 0) {
    query = query.where(
      "class_id",
      "in",
      classRows.map((row) => Number(row.id)),
    );
  }

  const users = await query.orderBy("id", "asc").execute();
  if (users.length === 0 || !conditionRule) return users;

  const ids = users.map((user) => Number(user.id));
  const [publishedRows, inviteRows, hnrRows] = await Promise.all([
    db
      .selectFrom("torrents")
      .select("uploader_id")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("uploader_id", "in", ids)
      .where("status", "=", "approved")
      .where("deleted_at", "is", null)
      .groupBy("uploader_id")
      .execute(),
    db
      .selectFrom("invites")
      .select("inviter_id")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("inviter_id", "in", ids)
      .where("status", "=", "used")
      .groupBy("inviter_id")
      .execute(),
    db
      .selectFrom("hnr_obligations")
      .select("user_id")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "in", ids)
      .where("status", "not in", ["reached", "cleared"])
      .groupBy("user_id")
      .execute(),
  ]);
  const publishedByUser = new Map(publishedRows.map((row) => [Number(row.uploader_id), Number(row.count)]));
  const invitesByUser = new Map(inviteRows.map((row) => [Number(row.inviter_id), Number(row.count)]));
  const hnrByUser = new Map(hnrRows.map((row) => [Number(row.user_id), Number(row.count)]));
  const now = Date.now();

  return users.filter((user) => {
    const metrics = buildMetrics(user as RecalcUser, now, {
      published: publishedByUser.get(Number(user.id)) ?? 0,
      invitesUsed: invitesByUser.get(Number(user.id)) ?? 0,
      hnrUnfinished: hnrByUser.get(Number(user.id)) ?? 0,
    });
    return evaluateRule(conditionRule, metrics);
  });
}

export function staffMessageRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/staff/messages/options`, async (request) => {
      requireAnnouncement(request);
      const rows = await db
        .selectFrom("classes")
        .select(["slug", "name", "rank"])
        .orderBy("rank", "asc")
        .execute();
      return staffMessageOptions.parse({
        classes: rows.map((row) => ({
          slug: row.slug,
          name: row.name,
          rank: Number(row.rank),
        })),
      });
    });

    app.post(`${API_PREFIX}/staff/messages/preview`, async (request) => {
      const auth = requireAnnouncement(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffMessageBody, request.body ?? {});
      normalizeLink(body.link_url);
      const users = await resolveRecipients(db, body);
      return staffMessagePreviewResponse.parse({
        recipients: users.length,
        sample: users.slice(0, SAMPLE_SIZE).map((user) => user.username),
      });
    });

    app.post(`${API_PREFIX}/staff/messages`, async (request) => {
      const auth = requireAnnouncement(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffMessageBody, request.body ?? {});
      const linkUrl = normalizeLink(body.link_url);
      const users = await resolveRecipients(db, body);
      if (users.length === 0) throw badRequest("no_recipients", "没有符合条件的收件人");

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        for (let index = 0; index < users.length; index += INSERT_CHUNK) {
          const chunk = users.slice(index, index + INSERT_CHUNK);
          await trx
            .insertInto("notifications")
            .values(
              chunk.map((user) => ({
                user_id: Number(user.id),
                kind: MESSAGE_KIND,
                title: body.title,
                body: body.body,
                link_url: linkUrl,
                read_at: null,
                created_at: now,
              })),
            )
            .execute();
        }
        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(auth.user.id),
            action: "staff.mass_message",
            target_type: "user",
            target_id: String(users.length),
            detail_json: JSON.stringify({
              recipients: users.length,
              class_slugs: body.class_slugs ?? [],
              user_ids: body.user_ids ?? [],
              conditions: body.conditions ?? null,
              title: body.title,
            }),
            ip: request.ip,
            created_at: now,
          })
          .execute();
      });

      return staffMessageSendResponse.parse({ recipients: users.length });
    });
  };
}
