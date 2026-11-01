import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import {
  API_PREFIX,
  PERMISSIONS,
  classRule,
  staffMessageBody,
  staffMessageJob,
  staffMessageOptions,
  staffMessagePreviewResponse,
  staffMessageSendResponse,
  type ClassRule,
  type StaffMessageJob,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { buildMetrics, type RecalcUser } from "../lib/class-decision.js";
import { evaluateRule } from "../lib/classes.js";
import { badRequest, forbidden, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";

const MESSAGE_KIND = "broadcast";
const SAMPLE_SIZE = 6;
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

function jobView(row: {
  token: string;
  status: string;
  recipients: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}): StaffMessageJob {
  return staffMessageJob.parse({
    token: row.token,
    status: row.status,
    recipients: Number(row.recipients),
    error: row.error,
    created_at: Number(row.created_at),
    started_at: row.started_at === null ? null : Number(row.started_at),
    finished_at: row.finished_at === null ? null : Number(row.finished_at),
  });
}

/** 处理一个已落库的群发任务；由请求触发，或由服务器定时补偿。 */
export async function processStaffMessageJob(db: Db, token: string): Promise<void> {
  const now = Date.now();
  const claimed = await db
    .updateTable("staff_message_jobs")
    .set({ status: "running", started_at: now })
    .where("token", "=", token)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) return;

  const job = await db
    .selectFrom("staff_message_jobs")
    .selectAll()
    .where("token", "=", token)
    .executeTakeFirst();
  if (!job) return;

  try {
    const body = staffMessageBody.parse(JSON.parse(job.payload_json) as unknown);
    const linkUrl = normalizeLink(body.link_url);
    const users = await resolveRecipients(db, body);
    if (users.length === 0) throw new Error("没有符合条件的收件人");

    const sentAt = Date.now();
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
              created_at: sentAt,
            })),
          )
          .execute();
      }
      await trx
        .insertInto("audit_logs")
        .values({
          actor_id: Number(job.actor_id),
          action: "staff.mass_message",
          target_type: "user",
          target_id: token,
          detail_json: JSON.stringify({
            recipients: users.length,
            class_slugs: body.class_slugs ?? [],
            user_ids: body.user_ids ?? [],
            conditions: body.conditions ?? null,
            title: body.title,
          }),
          ip: null,
          created_at: sentAt,
        })
        .execute();
      await trx
        .updateTable("staff_message_jobs")
        .set({ status: "completed", recipients: users.length, finished_at: sentAt })
        .where("token", "=", token)
        .execute();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .updateTable("staff_message_jobs")
      .set({ status: "failed", error: message.slice(0, 1000), finished_at: Date.now() })
      .where("token", "=", token)
      .execute();
  }
}

/** 服务器启动/定时补偿：处理 queued 任务，并把卡住的 running 任务放回队列。 */
export async function processQueuedStaffMessageJobs(db: Db): Promise<number> {
  const staleCutoff = Date.now() - 10 * 60 * 1000;
  await db
    .updateTable("staff_message_jobs")
    .set({ status: "queued", started_at: null })
    .where("status", "=", "running")
    .where("started_at", "<", staleCutoff)
    .execute();

  const rows = await db
    .selectFrom("staff_message_jobs")
    .select("token")
    .where("status", "=", "queued")
    .orderBy("id", "asc")
    .limit(5)
    .execute();
  for (const row of rows) {
    await processStaffMessageJob(db, row.token);
  }
  return rows.length;
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

    app.get(`${API_PREFIX}/staff/messages/jobs/:token`, async (request) => {
      const auth = requireAnnouncement(request);
      const token = (request.params as { token: string }).token;
      const job = await db
        .selectFrom("staff_message_jobs")
        .selectAll()
        .where("token", "=", token)
        .where("actor_id", "=", Number(auth.user.id))
        .executeTakeFirst();
      if (!job) throw notFound("message_job_not_found", "群发任务不存在");
      return jobView(job);
    });

    app.post(`${API_PREFIX}/staff/messages`, async (request) => {
      const auth = requireAnnouncement(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffMessageBody, request.body ?? {});
      normalizeLink(body.link_url);

      const token = randomBytes(16).toString("hex");
      const now = Date.now();
      await db
        .insertInto("staff_message_jobs")
        .values({
          token,
          actor_id: Number(auth.user.id),
          payload_json: JSON.stringify(body),
          status: "queued",
          recipients: 0,
          error: null,
          created_at: now,
          started_at: null,
          finished_at: null,
        })
        .execute();

      void processStaffMessageJob(db, token);

      return staffMessageSendResponse.parse({ job_token: token, status: "queued" });
    });
  };
}
