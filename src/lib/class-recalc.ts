import type { Kysely, Transaction } from "kysely";
import type { Db } from "../db/db.js";
import type { Database } from "../db/types.js";
import {
  evaluateRule,
  isAutoDemote,
  isAutoPromote,
  nextHigherClass,
  parseRule,
  pickHighestEligible,
  ruleKey,
  type ClassRow,
  type UserMetrics,
} from "./classes.js";
import { notifyClassChange } from "./class-notifications.js";

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
    .where("status", "!=", "reached")
    .groupBy("user_id")
    .execute();
  const hnrByUser = new Map(hnrRows.map((row) => [Number(row.user_id), Number(row.count)]));

  const now = Date.now();
  let scanned = 0;
  let promoted = 0;
  let demoted = 0;

  try {
    for (const user of users) {
      const lockedUntil = user.class_locked_until === null ? null : Number(user.class_locked_until);
      if (lockedUntil !== null && lockedUntil > now) continue;

      const current =
        user.class_id === null ? null : (classById.get(Number(user.class_id)) ?? null);
      if (!current) continue;
      scanned += 1;

      const ratio =
        Number(user.downloaded) > 0
          ? Number(user.uploaded) / Number(user.downloaded)
          : Infinity;
      const metrics: UserMetrics = {
        age_days: Math.max(0, Math.floor((now - Number(user.created_at)) / 86_400_000)),
        uploaded: Number(user.uploaded),
        downloaded: Number(user.downloaded),
        ratio,
        seedtime_hours: Number(user.seedtime) / 3600,
        bonus: Number(user.bonus),
        torrents_published: publishedByUser.get(Number(user.id)) ?? 0,
        invites_used: invitesByUser.get(Number(user.id)) ?? 0,
        warnings: Number(user.warnings ?? 0),
        hnr_unfinished: hnrByUser.get(Number(user.id)) ?? 0,
        last_active_days:
          user.last_seen_at === null
            ? 9999
            : Math.max(0, Math.floor((now - Number(user.last_seen_at)) / 86_400_000)),
      };

      const historyUser = { id: Number(user.id), class_id: user.class_id, username: user.username };

      // ---- 降级判定（仅当前等级允许自动降级） ----
      let demoteTarget: ClassRow | null = null;
      let demoteReason = "";
      if (isAutoDemote(current)) {
        const violation =
          rules.matrix_enabled && Number(current.exempt_ratio_matrix) === 0
            ? rules.ratio_matrix.find(
                (row) => Number(user.downloaded) >= row.download_gb * GB && ratio < row.min_ratio,
              )
            : undefined;

        if (violation) {
          demoteTarget = classBySlug.get("leechwarn") ?? null;
          demoteReason = `下载量超过 ${String(violation.download_gb)}GB 时分享率低于 ${String(violation.min_ratio)}`;
        } else {
          const demoteRule = parseRule(current.demote_rule_json);
          if (demoteRule) {
            if (evaluateRule(demoteRule, metrics)) {
              const configured = current.demote_target_slug
                ? (classBySlug.get(current.demote_target_slug) ?? null)
                : null;
              demoteTarget = configured ?? pickHighestEligible(classes, metrics);
              demoteReason = "不再满足当前等级条件";
            }
          } else {
            const promoteRule = parseRule(current.promote_rule_json);
            if (promoteRule && !evaluateRule(promoteRule, metrics)) {
              demoteTarget = pickHighestEligible(classes, metrics);
              demoteReason = "不再满足当前等级条件";
            }
          }
        }
      }

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
      let cursor = current;
      for (let guard = 0; guard < classes.length; guard += 1) {
        const next = nextHigherClass(classes, Number(cursor.rank));
        if (!next) break;
        if (!isAutoPromote(next)) {
          cursor = next;
          continue;
        }
        const promoteRule = parseRule(next.promote_rule_json);
        if (!promoteRule || !evaluateRule(promoteRule, metrics)) break;

        // 条件完全相同的等级只自动获得较低的那个，避免一次检查穿过同条件等级。
        if (ruleKey(promoteRule) === ruleKey(parseRule(cursor.promote_rule_json))) break;

        const graceDays = Number(next.promote_grace_days);
        if (graceDays > 0) {
          const progress = await db
            .selectFrom("user_class_progress")
            .selectAll()
            .where("user_id", "=", user.id)
            .where("target_class_id", "=", Number(next.id))
            .executeTakeFirst();
          if (!progress) {
            await db
              .insertInto("user_class_progress")
              .values({
                user_id: Number(user.id),
                target_class_id: Number(next.id),
                first_met_at: now,
                last_checked_at: now,
              })
              .execute();
            break;
          }
          if (now - Number(progress.first_met_at) < graceDays * 86_400_000) {
            await db
              .updateTable("user_class_progress")
              .set({ last_checked_at: now })
              .where("id", "=", progress.id)
              .execute();
            break;
          }
          await db.deleteFrom("user_class_progress").where("id", "=", progress.id).execute();
        }

        await db.transaction().execute(async (trx) => {
          await applyClassChange(trx, {
            user: historyUser,
            fromClass: cursor,
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
          oldName: cursor.name,
          newName: next.name,
          reason: "满足升级条件",
        });
        promoted += 1;
        cursor = next;
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
