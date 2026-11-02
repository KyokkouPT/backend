import type { Db } from "../db/db.js";
import type { ClassBrief } from "@kyokkou/contracts";
import {
  evaluateRule,
  isAutoDemote,
  isAutoPromote,
  missingConditions,
  nextHigherClass,
  parseRule,
  pickHighestEligible,
  ruleKey,
  toClassBrief,
  type ClassRow,
  type UserMetrics,
} from "./classes.js";
import { loadClassRules, type ClassRules } from "./class-recalc.js";

const GB = 1024 ** 3;

export type ClassDecision = {
  /** keep：下次重算不会变更；promote/demote：会变更（含缓冲/观察期未到期的情况）。 */
  action: "promote" | "demote" | "keep";
  /** 立即执行的目标等级（缓冲/观察期未到期时为 null）。 */
  target: ClassRow | null;
  /** 最终可能到达的等级（含缓冲/观察期未结束时预示的目标）。 */
  finalTarget: ClassRow | null;
  /** 逐级升级路径（不含当前等级）。 */
  path: ClassRow[];
  missing: string[];
  demoteReason: string | null;
  /** 降级缓冲到期时间（已有则返回，未有则给预计时间）。 */
  demoteDueAt: number | null;
  blockedReason: string | null;
};

export type UserClassContext = {
  metrics: UserMetrics;
  classes: ClassRow[];
  classById: Map<number, ClassRow>;
  classBySlug: Map<string, ClassRow>;
  rules: ClassRules;
  recoveryBands?: { min_download_bytes: number; max_download_bytes: number | null; min_ratio: number }[];
  /** 预加载的 user_class_progress：`userId:targetClassId` -> first_met_at。 */
  progress?: Map<string, number>;
};

export type RecalcUser = {
  id: number;
  username: string;
  class_id: number | null;
  created_at: number;
  last_seen_at: number | null;
  uploaded: number;
  downloaded: number;
  raw_uploaded: number;
  raw_downloaded: number;
  bonus: number;
  seed_points: number;
  seedtime: number;
  warnings: number | null;
  class_locked_until: number | null;
  demote_due_at: number | null;
};

export function ratioOf(uploaded: number, downloaded: number): number {
  return downloaded > 0 ? uploaded / downloaded : Number.POSITIVE_INFINITY;
}

/** 由批次统计构造某个用户的条件指标；模拟器与重算共用。 */
export function buildMetrics(
  user: RecalcUser,
  now: number,
  extra: { published: number; invitesUsed: number; hnrUnfinished: number },
): UserMetrics {
  return {
    age_days: Math.max(0, Math.floor((now - Number(user.created_at)) / 86_400_000)),
    uploaded: Number(user.uploaded),
    downloaded: Number(user.downloaded),
    raw_uploaded: Number(user.raw_uploaded),
    raw_downloaded: Number(user.raw_downloaded),
    ratio: ratioOf(Number(user.uploaded), Number(user.downloaded)),
    seedtime_hours: Number(user.seedtime) / 3600,
    bonus: Number(user.bonus),
    seed_points: Number(user.seed_points),
    torrents_published: extra.published,
    invites_used: extra.invitesUsed,
    warnings: Number(user.warnings ?? 0),
    hnr_unfinished: extra.hnrUnfinished,
    last_active_days:
      user.last_seen_at === null
        ? 9999
        : Math.max(0, Math.floor((now - Number(user.last_seen_at)) / 86_400_000)),
  };
}

/** 分享率矩阵命中项（不满足返回命中行）。 */
export function matrixViolation(
  rules: ClassRules,
  current: ClassRow,
  downloaded: number,
  ratio: number,
): ClassRules["ratio_matrix"][number] | undefined {
  if (!rules.matrix_enabled || Number(current.exempt_ratio_matrix) !== 0) return undefined;
  return rules.ratio_matrix.find(
    (row) => downloaded >= row.download_gb * GB && ratio < row.min_ratio,
  );
}

/** 当前等级是否应自动降级；返回目标与原因（不需要降级时 target 为 null）。 */
export function decideDemotion(
  ctx: UserClassContext,
  current: ClassRow,
  user: RecalcUser,
  metrics: UserMetrics,
): { target: ClassRow | null; reason: string | null } {
  if (!isAutoDemote(current)) return { target: null, reason: null };

  const violation = matrixViolation(ctx.rules, current, metrics.downloaded, metrics.ratio);
  if (violation) {
    const target =
      ctx.classBySlug.get(ctx.rules.matrix_target_slug) ?? ctx.classBySlug.get("leechwarn") ?? null;
    return {
      target,
      reason: `下载量超过 ${String(violation.download_gb)}GB 时分享率低于 ${String(violation.min_ratio)}`,
    };
  }

  const demoteRule = parseRule(current.demote_rule_json);
  if (demoteRule) {
    // NexusPHP 语义：存在降级规则时，只由该规则决定是否降级。
    if (!evaluateRule(demoteRule, metrics)) return { target: null, reason: null };
    const configured = current.demote_target_slug
      ? (ctx.classBySlug.get(current.demote_target_slug) ?? null)
      : null;
    const lower = ctx.classes
      .filter((row) => Number(row.rank) < Number(current.rank))
      .sort((a, b) => Number(b.rank) - Number(a.rank))[0] ?? null;
    return {
      target: configured ?? lower,
      reason: "不再满足当前等级条件",
    };
  }

  // 没有降级规则时，才回退到升级规则判断。
  const promoteRule = parseRule(current.promote_rule_json);
  if (promoteRule && !evaluateRule(promoteRule, metrics)) {
    return {
      target: pickHighestEligible(ctx.classes, metrics),
      reason: "不再满足当前等级条件",
    };
  }
  return { target: null, reason: null };
}

export type PromotionStep = {
  from: ClassRow;
  to: ClassRow;
  graceDays: number;
  /** 观察期是否已满足（graceDays=0 视为满足）。 */
  graceSatisfied: boolean;
};

/** 逐级升级候选序列；停在第一个不满足条件/同条件/观察期未满的等级。 */
export async function decidePromotion(
  db: Db,
  ctx: UserClassContext,
  current: ClassRow,
  userId: number,
  metrics: UserMetrics,
  now: number,
): Promise<{ steps: PromotionStep[]; missing: string[]; blocked: PromotionStep | null }> {
  const steps: PromotionStep[] = [];
  let cursor = current;

  for (let guard = 0; guard < ctx.classes.length; guard += 1) {
    const next = nextHigherClass(ctx.classes, Number(cursor.rank));
    if (!next) break;
    if (!isAutoPromote(next)) {
      cursor = next;
      continue;
    }

    if (current.slug === "leechwarn" && next.slug === "user") {
      const band = (ctx.recoveryBands ?? []).find(
        (item) =>
          metrics.downloaded >= Number(item.min_download_bytes) &&
          (item.max_download_bytes === null ||
            metrics.downloaded < Number(item.max_download_bytes)),
      );
      if (!band || metrics.ratio < Number(band.min_ratio)) break;
      steps.push({ from: cursor, to: next, graceDays: 0, graceSatisfied: true });
      cursor = next;
      continue;
    }

    const promoteRule = parseRule(next.promote_rule_json);
    // 空条件不能被当成“无条件升级”：否则受限等级会在每次重算时被
    // 自动升回新用户，再被分享率矩阵降回受限，形成历史记录反复横跳。
    if (!promoteRule || promoteRule.conditions.length === 0) break;
    if (!evaluateRule(promoteRule, metrics)) {
      return { steps, missing: missingConditions(promoteRule, metrics), blocked: null };
    }
    if (ruleKey(promoteRule) === ruleKey(parseRule(cursor.promote_rule_json))) break;

    const graceDays = Number(next.promote_grace_days);
    if (graceDays > 0) {
      const progressKey = `${String(userId)}:${String(next.id)}`;
      const firstMet =
        ctx.progress?.get(progressKey) ??
        (await db
          .selectFrom("user_class_progress")
          .select("first_met_at")
          .where("user_id", "=", userId)
          .where("target_class_id", "=", Number(next.id))
          .executeTakeFirst()
          .then((row) => (row ? Number(row.first_met_at) : undefined)));
      if (firstMet === undefined) {
        return {
          steps,
          missing: [],
          blocked: { from: cursor, to: next, graceDays, graceSatisfied: false },
        };
      }
      if (now - firstMet < graceDays * 86_400_000) {
        return {
          steps,
          missing: [],
          blocked: { from: cursor, to: next, graceDays, graceSatisfied: false },
        };
      }
    }

    steps.push({ from: cursor, to: next, graceDays, graceSatisfied: true });
    cursor = next;
  }

  return { steps, missing: [], blocked: null };
}

export function isLocked(user: RecalcUser, now: number): boolean {
  return user.class_locked_until !== null && Number(user.class_locked_until) > now;
}

/**
 * 纯判定：不写库、不发通知。
 * 返回结果与下次重算对该用户的实际动作一致（缓冲/观察期未到期时 target 留空并给出说明）。
 */
export async function evaluateUserClass(
  db: Db,
  user: RecalcUser,
  ctx: UserClassContext,
  now = Date.now(),
): Promise<ClassDecision & { current: ClassRow | null }> {
  const current =
    user.class_id === null ? null : (ctx.classById.get(Number(user.class_id)) ?? null);
  const locked = isLocked(user, now);

  if (!current) {
    return {
      action: "keep",
      target: null,
      finalTarget: null,
      path: [],
      missing: [],
      demoteReason: null,
      demoteDueAt: null,
      blockedReason: "用户没有有效等级",
      current: null,
    };
  }

  if (locked) {
    return {
      action: "keep",
      target: null,
      finalTarget: null,
      path: [],
      missing: [],
      demoteReason: null,
      demoteDueAt: user.demote_due_at === null ? null : Number(user.demote_due_at),
      blockedReason: "等级已锁定，自动重算会跳过该用户",
      current,
    };
  }

  const demotion = decideDemotion(ctx, current, user, ctx.metrics);
  if (demotion.target && Number(demotion.target.rank) < Number(current.rank)) {
    const graceDays = Number(current.demote_grace_days);
    if (graceDays > 0) {
      const dueAt = user.demote_due_at === null ? null : Number(user.demote_due_at);
      if (dueAt === null) {
        const due = now + graceDays * 86_400_000;
        return {
          action: "demote",
          target: null,
          finalTarget: demotion.target,
          path: [],
          missing: [],
          demoteReason: demotion.reason,
          demoteDueAt: due,
          blockedReason: `降级缓冲中：预计 ${String(graceDays)} 天后（约 ${new Date(due).toISOString().slice(0, 10)}）执行`,
          current,
        };
      }
      if (dueAt > now) {
        return {
          action: "demote",
          target: null,
          finalTarget: demotion.target,
          path: [],
          missing: [],
          demoteReason: demotion.reason,
          demoteDueAt: dueAt,
          blockedReason: `降级缓冲中：${new Date(dueAt).toISOString().slice(0, 10)} 后执行`,
          current,
        };
      }
    }
    return {
      action: "demote",
      target: demotion.target,
      finalTarget: demotion.target,
      path: [],
      missing: [],
      demoteReason: demotion.reason,
      demoteDueAt: user.demote_due_at === null ? null : Number(user.demote_due_at),
      blockedReason: null,
      current,
    };
  }

  const promotion = await decidePromotion(db, ctx, current, user.id, ctx.metrics, now);
  if (promotion.steps.length > 0) {
    const finals = promotion.steps[promotion.steps.length - 1] as PromotionStep;
    return {
      action: "promote",
      target: finals.to,
      finalTarget: finals.to,
      path: promotion.steps.map((step) => step.to),
      missing: [],
      demoteReason: null,
      demoteDueAt: null,
      blockedReason: promotion.blocked
        ? `观察期进行中：升级到「${promotion.blocked.to.name}」需连续达标 ${String(promotion.blocked.graceDays)} 天`
        : null,
      current,
    };
  }

  if (promotion.blocked) {
    return {
      action: "promote",
      target: null,
      finalTarget: promotion.blocked.to,
      path: [],
      missing: [],
      demoteReason: null,
      demoteDueAt: null,
      blockedReason: `观察期刚开始：达到「${promotion.blocked.to.name}」需连续达标 ${String(promotion.blocked.graceDays)} 天`,
      current,
    };
  }

  return {
    action: "keep",
    target: null,
    finalTarget: null,
    path: [],
    missing: promotion.missing,
    demoteReason: null,
    demoteDueAt: user.demote_due_at === null ? null : Number(user.demote_due_at),
    blockedReason: null,
    current,
  };
}

export function toBrief(row: ClassRow | null): ClassBrief | null {
  return row ? toClassBrief(row) : null;
}
