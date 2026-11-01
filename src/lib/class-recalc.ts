import type { Kysely, Transaction } from "kysely";
import type { Db } from "../db/db.js";
import type { Database } from "../db/types.js";
import type { ClassRow, UserMetrics } from "./classes.js";
import { notifyClassChange } from "./class-notifications.js";
import {
  buildMetrics,
  decideDemotion,
  decidePromotion,
  isLocked,
  type RecalcUser,
  type UserClassContext,
} from "./class-decision.js";

type DbLike = Kysely<Database> | Transaction<Database>;

const GB = 1024 ** 3;

export type RatioMatrixRow = { download_gb: number; min_ratio: number };

export const DEFAULT_RATIO_MATRIX: RatioMatrixRow[] = [
  { download_gb: 50, min_ratio: 0.4 },
  { download_gb: 100, min_ratio: 0.5 },
  { download_gb: 200, min_ratio: 0.6 },
  { download_gb: 400, min_ratio: 0.7 },
  { download_gb: 800, min_ratio: 0.8 },
];

export type ClassRules = {
  matrix_enabled: boolean;
  ratio_matrix: RatioMatrixRow[];
};

export const DEFAULT_CLASS_RULES: ClassRules = {
  matrix_enabled: true,
  ratio_matrix: DEFAULT_RATIO_MATRIX,
};

export async function loadClassRules(db: Db): Promise<ClassRules> {
  const row = await db
    .selectFrom("site_settings")
    .select("value_json")
    .where("key", "=", "class_rules")
    .executeTakeFirst();
  if (!row) return DEFAULT_CLASS_RULES;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<ClassRules>;
    const matrix = Array.isArray(parsed.ratio_matrix)
      ? parsed.ratio_matrix
          .filter(
            (item): item is RatioMatrixRow =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as RatioMatrixRow).download_gb === "number" &&
              typeof (item as RatioMatrixRow).min_ratio === "number",
          )
          .sort((a, b) => a.download_gb - b.download_gb)
      : DEFAULT_RATIO_MATRIX;
    return {
      matrix_enabled: parsed.matrix_enabled !== false,
      ratio_matrix: matrix.length > 0 ? matrix : DEFAULT_RATIO_MATRIX,
    };
  } catch {
    return DEFAULT_CLASS_RULES;
  }
}

export async function saveClassRules(db: Db, rules: ClassRules): Promise<void> {
  const now = Date.now();
  const value = JSON.stringify(rules);
  const updated = await db
    .updateTable("site_settings")
    .set({ value_json: value, updated_at: now })
    .where("key", "=", "class_rules")
    .execute();
  if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
    await db.insertInto("site_settings").values({ key: "class_rules", value_json: value, updated_at: now }).execute();
  }
}

async function markRunFinished(
  db: Db,
  runId: number,
  values: Partial<{
    finished_at: number;
    scanned: number;
    promoted: number;
    demoted: number;
    error: string | null;
  }>,
): Promise<void> {
  await db.updateTable("class_recalc_runs").set(values).where("id", "=", runId).execute();
}

type RecalcOptions = {
  triggeredBy: "cron" | "manual";
  actorId: number | null;
};

export type RecalcResult = {
  scanned: number;
  promoted: number;
  demoted: number;
};

async function applyClassChange(
  trx: Kysely<Database> | Transaction<Database>,
  input: {
    user: { id: number; class_id: number | null; username: string };
    fromClass: ClassRow | null;
    toClass: ClassRow;
    source: "auto" | "manual" | "system";
    reason: string;
    actorId: number | null;
    now: number;
    inviteDelta?: number;
  },
): Promise<void> {
  await trx
    .updateTable("users")
    .set({
      class_id: Number(input.toClass.id),
      class_key: input.toClass.slug,
      demote_due_at: null,
    })
    .where("id", "=", input.user.id)
    .execute();

  if (input.inviteDelta && input.inviteDelta !== 0) {
    await trx
      .updateTable("users")
      .set((eb) => ({ invite_balance: eb("invite_balance", "+", input.inviteDelta as number) }))
      .where("id", "=", input.user.id)
      .execute();
  }

  await trx
    .insertInto("user_class_history")
    .values({
      user_id: input.user.id,
      from_class_id: input.fromClass ? Number(input.fromClass.id) : null,
      to_class_id: Number(input.toClass.id),
      source: input.source,
      reason: input.reason,
      detail_json: JSON.stringify({
        from: input.fromClass?.slug ?? null,
        to: input.toClass.slug,
      }),
      actor_id: input.actorId,
      created_at: input.now,
    })
    .execute();

  await trx
    .insertInto("audit_logs")
    .values({
      actor_id: input.actorId,
      action: input.source === "auto" ? "class.auto_change" : "class.set",
      target_type: "user",
      target_id: String(input.user.id),
      detail_json: JSON.stringify({
        from: input.fromClass?.slug ?? null,
        to: input.toClass.slug,
        reason: input.reason,
      }),
      ip: null,
      created_at: input.now,
    })
    .execute();
}

export async function runClassRecalc(db: Db, options: RecalcOptions): Promise<RecalcResult> {
  const startedAt = Date.now();
  await db
    .insertInto("class_recalc_runs")
    .values({
      started_at: startedAt,
      finished_at: null,
      scanned: 0,
      promoted: 0,
      demoted: 0,
      error: null,
      triggered_by: options.triggeredBy,
      actor_id: options.actorId,
    })
    .execute();

  const runRow = await db
    .selectFrom("class_recalc_runs")
    .select("id")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const runId = Number(runRow?.id ?? 0);

  const rules = await loadClassRules(db);
  const classes = await db.selectFrom("classes").selectAll().orderBy("rank", "asc").execute();
  const classById = new Map(classes.map((row) => [Number(row.id), row]));
  const classBySlug = new Map(classes.map((row) => [row.slug, row]));

  const users = await db
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
    .where("status", "=", "active")
    .execute();

  const publishedRows = await db
    .selectFrom("torrents")
    .select("uploader_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("status", "=", "approved")
    .where("deleted_at", "is", null)
    .groupBy("uploader_id")
    .execute();
  const publishedByUser = new Map(publishedRows.map((row) => [Number(row.uploader_id), Number(row.count)]));

  const inviteRows = await db
    .selectFrom("invites")
    .select("inviter_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("status", "=", "used")
    .groupBy("inviter_id")
    .execute();
  const invitesByUser = new Map(inviteRows.map((row) => [Number(row.inviter_id), Number(row.count)]));

  const hnrRows = await db
    .selectFrom("hnr_obligations")
    .select("user_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("status", "not in", ["reached", "cleared"])
    .groupBy("user_id")
    .execute();
  const hnrByUser = new Map(hnrRows.map((row) => [Number(row.user_id), Number(row.count)]));

  const progressRows = await db
    .selectFrom("user_class_progress")
    .select(["user_id", "target_class_id", "first_met_at"])
    .execute();
  const progressByUser = new Map(
    progressRows.map((row) => [
      `${String(row.user_id)}:${String(row.target_class_id)}`,
      Number(row.first_met_at),
    ]),
  );

  const now = Date.now();
  let scanned = 0;
  let promoted = 0;
  let demoted = 0;

  try {
    for (const user of users) {
      if (isLocked(user, now)) continue;

      const current =
        user.class_id === null ? null : (classById.get(Number(user.class_id)) ?? null);
      if (!current) continue;
      scanned += 1;

      const metrics: UserMetrics = buildMetrics(user, now, {
        published: publishedByUser.get(Number(user.id)) ?? 0,
        invitesUsed: invitesByUser.get(Number(user.id)) ?? 0,
        hnrUnfinished: hnrByUser.get(Number(user.id)) ?? 0,
      });
      const ctx: UserClassContext = { metrics, classes, classById, classBySlug, rules, progress: progressByUser };

      const historyUser = { id: Number(user.id), class_id: user.class_id, username: user.username };

      // ---- 降级判定（仅当前等级允许自动降级） ----
      const demotion = decideDemotion(ctx, current, user as RecalcUser, metrics);
      const demoteTarget: ClassRow | null = demotion.target;
      const demoteReason = demotion.reason ?? "";

      if (demoteTarget && Number(demoteTarget.rank) < Number(current.rank)) {
        const graceDays = Number(current.demote_grace_days);
        if (graceDays > 0) {
          const dueAt = user.demote_due_at === null ? null : Number(user.demote_due_at);
          if (dueAt === null) {
            const due = now + graceDays * 86_400_000;
            await db
              .updateTable("users")
              .set({ demote_due_at: due })
              .where("id", "=", user.id)
              .execute();
            await notifyClassChange(db, {
              userId: Number(user.id),
              kind: "demote_warning",
              oldName: current.name,
              newName: demoteTarget.name,
              reason: demoteReason,
              date: new Date(due).toISOString().slice(0, 10),
            });
            continue;
          }
          if (dueAt > now) continue;
        }

        await db.transaction().execute(async (trx) => {
          await applyClassChange(trx, {
            user: historyUser,
            fromClass: current,
            toClass: demoteTarget as ClassRow,
            source: "auto",
            reason: demoteReason,
            actorId: options.actorId,
            now,
          });
        });
        await notifyClassChange(db, {
          userId: Number(user.id),
          kind: "demote",
          oldName: current.name,
          newName: demoteTarget.name,
          reason: demoteReason,
        });
        demoted += 1;
        continue;
      }

      if (user.demote_due_at !== null) {
        await db.updateTable("users").set({ demote_due_at: null }).where("id", "=", user.id).execute();
      }

      // ---- 升级判定：逐级升，可一次连升多级 ----
      const promotion = await decidePromotion(db, ctx, current, Number(user.id), metrics, now);

      if (promotion.blocked) {
        // 观察期：首次达标写入进度，未满期时只更新时间。
        const targetId = Number(promotion.blocked.to.id);
        const progress = await db
          .selectFrom("user_class_progress")
          .selectAll()
          .where("user_id", "=", user.id)
          .where("target_class_id", "=", targetId)
          .executeTakeFirst();
        if (!progress) {
          await db
            .insertInto("user_class_progress")
            .values({
              user_id: Number(user.id),
              target_class_id: targetId,
              first_met_at: now,
              last_checked_at: now,
            })
            .execute();
        } else {
          await db
            .updateTable("user_class_progress")
            .set({ last_checked_at: now })
            .where("id", "=", progress.id)
            .execute();
        }
      }

      for (const step of promotion.steps) {
        const next = step.to;
        if (step.graceDays > 0) {
          await db
            .deleteFrom("user_class_progress")
            .where("user_id", "=", user.id)
            .where("target_class_id", "=", Number(next.id))
            .execute();
        }

        await db.transaction().execute(async (trx) => {
          await applyClassChange(trx, {
            user: historyUser,
            fromClass: step.from,
            toClass: next,
            source: "auto",
            reason: "满足升级条件",
            actorId: options.actorId,
            now,
            inviteDelta: Number(next.invite_quota),
          });
        });
        await notifyClassChange(db, {
          userId: Number(user.id),
          kind: "promote",
          oldName: step.from.name,
          newName: next.name,
          reason: "满足升级条件",
        });
        promoted += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId > 0) {
      await markRunFinished(db, runId, {
        finished_at: Date.now(),
        scanned,
        promoted,
        demoted,
        error: message,
      });
    }
    throw error;
  }

  if (runId > 0) {
    await markRunFinished(db, runId, {
      finished_at: Date.now(),
      scanned,
      promoted,
      demoted,
      error: null,
    });
  }

  return { scanned, promoted, demoted };
}
