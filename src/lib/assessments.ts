import { randomBytes } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import type {
  AssessmentAssignmentItem,
  AssessmentOfferItem,
  AssessmentPenalty,
  AssessmentProgressItem,
  AssessmentRequirementItem,
  AssessmentRequirements,
  AssessmentReward,
  StaffAssessmentBody,
  StaffAssessmentItem,
  StaffAssessmentParticipant,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import type { AssessmentAssignmentsTable, AssessmentsTable, Database } from "../db/types.js";
import { applyClassChange } from "./class-recalc.js";
import { loadClassById, loadClassBySlug } from "./classes.js";
import { createNotification } from "./notifications.js";
import { badRequest, conflict } from "./problem.js";

const GB = 1024 ** 3;
const ACTIVE_STATUSES = ["assigned", "claimed", "in_progress"] as const;

export const ASSESSMENT_METRIC_LABELS: Record<string, string> = {
  uploaded_delta: "上传增量",
  downloaded_delta: "下载增量",
  seedtime_delta: "做种时长增量",
  bonus_delta: "魔力增量",
  published_delta: "发布种子数",
  ratio: "分享率",
  last_active_days: "最近活跃天数",
  warnings: "警告次数",
  hnr_unfinished: "未完成 H&R",
};

const TRAFFIC_METRICS = new Set(["uploaded_delta", "downloaded_delta"]);

type AssessmentRow = Selectable<AssessmentsTable>;
type AssignmentRow = Selectable<AssessmentAssignmentsTable>;
type DbLike = Kysely<Database> | Transaction<Database>;

export type ParsedAssessment = {
  row: AssessmentRow;
  filters: Record<string, unknown>;
  requirements: AssessmentRequirements;
  reward: AssessmentReward;
  penalty: AssessmentPenalty;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeReward(raw: unknown): AssessmentReward {
  const value = (raw ?? {}) as Partial<AssessmentReward>;
  return {
    bonus: Number(value.bonus ?? 0),
    invite: Number(value.invite ?? 0),
    class_slug: value.class_slug ?? null,
    custom_title: value.custom_title ?? null,
  };
}

function normalizePenalty(raw: unknown): AssessmentPenalty {
  const value = (raw ?? {}) as Partial<AssessmentPenalty>;
  return {
    bonus: Number(value.bonus ?? 0),
    invite: Number(value.invite ?? 0),
    warn: Number(value.warn ?? 0),
    class_slug: value.class_slug ?? null,
    suspend_days: Number(value.suspend_days ?? 0),
    ban: Boolean(value.ban),
  };
}

export function parseAssessment(row: AssessmentRow): ParsedAssessment {
  const requirements = parseJson<AssessmentRequirements>(row.requirements_json, {
    logic: "all",
    items: [],
  });
  return {
    row,
    filters: parseJson<Record<string, unknown>>(row.filters_json, {}),
    requirements: {
      logic: requirements.logic === "any" ? "any" : "all",
      items: Array.isArray(requirements.items) ? requirements.items : [],
    },
    reward: normalizeReward(parseJson(row.success_reward_json, {})),
    penalty: normalizePenalty(parseJson(row.failure_penalty_json, {})),
  };
}

function requirementTarget(requirement: AssessmentRequirementItem): number {
  if (TRAFFIC_METRICS.has(requirement.metric)) return requirement.value * GB;
  if (requirement.metric === "seedtime_delta") return requirement.value * 3600;
  return requirement.value;
}

function compare(current: number, op: AssessmentRequirementItem["op"], target: number): boolean {
  switch (op) {
    case ">=":
      return current >= target;
    case ">":
      return current > target;
    case "<=":
      return current <= target;
    case "<":
      return current < target;
    case "==":
      return current === target;
    case "!=":
      return current !== target;
    default:
      return false;
  }
}

function progressDisplay(
  requirement: AssessmentRequirementItem,
  current: number,
  target: number,
): AssessmentProgressItem {
  const traffic = TRAFFIC_METRICS.has(requirement.metric);
  const seedtime = requirement.metric === "seedtime_delta";
  const divisor = traffic ? GB : seedtime ? 3600 : 1;
  return {
    metric: requirement.metric,
    label: ASSESSMENT_METRIC_LABELS[requirement.metric] ?? requirement.metric,
    current: current / divisor,
    target: target / divisor,
    unit: traffic ? "GB" : null,
  };
}

function rawProgress(requirement: AssessmentRequirementItem, current: number, target: number) {
  return {
    metric: requirement.metric,
    current,
    target,
  };
}

export async function countAssessmentParticipants(db: Db, assessmentId: number) {
  const rows = await db
    .selectFrom("assessment_assignments")
    .select(["status"])
    .where("assessment_id", "=", assessmentId)
    .execute();
  return {
    participants: rows.length,
    active_participants: rows.filter((row) => ACTIVE_STATUSES.includes(row.status as never)).length,
    passed: rows.filter((row) => row.status === "passed").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };
}

export async function toStaffAssessment(db: Db, row: AssessmentRow): Promise<StaffAssessmentItem> {
  const parsed = parseAssessment(row);
  const counts = await countAssessmentParticipants(db, Number(row.id));
  return {
    id: Number(row.id),
    name: row.name,
    description_markdown: row.description_markdown,
    type: row.type as "exam" | "task",
    status: row.status as "draft" | "active" | "paused" | "archived",
    begin_at: row.begin_at === null ? null : Number(row.begin_at),
    end_at: row.end_at === null ? null : Number(row.end_at),
    duration_days: Number(row.duration_days),
    recurring: row.recurring as "none" | "daily" | "weekly" | "monthly",
    filters: parsed.filters as never,
    requirements: parsed.requirements,
    reward: parsed.reward,
    penalty: parsed.penalty,
    max_participants: Number(row.max_participants),
    allow_concurrent: Number(row.allow_concurrent) === 1,
    settle_early: Number(row.settle_early) === 1,
    auto_assign: Number(row.auto_assign) === 1,
    priority: Number(row.priority),
    created_by: Number(row.created_by),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    ...counts,
  };
}

export async function getAssessment(db: Db, id: number): Promise<AssessmentRow | undefined> {
  return db.selectFrom("assessments").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function listAssessmentOffers(db: Db, userId: number): Promise<AssessmentOfferItem[]> {
  const rows = await db
    .selectFrom("assessments")
    .selectAll()
    .where("status", "=", "active")
    .where("type", "=", "task")
    .orderBy("created_at", "desc")
    .execute();
  const claimed = await db
    .selectFrom("assessment_assignments")
    .select(["assessment_id", "status"])
    .where("user_id", "=", userId)
    .execute();
  const activeByAssessment = new Set(claimed.map((row) => Number(row.assessment_id)));
  return rows
    .filter((row) => {
      return Number(row.allow_concurrent) === 1 || !activeByAssessment.has(Number(row.id));
    })
    .map((row) => {
      const parsed = parseAssessment(row);
      return {
        id: Number(row.id),
        name: row.name,
        type: row.type as "exam" | "task",
        description_markdown: row.description_markdown,
        begin_at: row.begin_at === null ? null : Number(row.begin_at),
        end_at: row.end_at === null ? null : Number(row.end_at),
        requirements: parsed.requirements,
        reward: parsed.reward,
        penalty: parsed.penalty,
        max_participants: Number(row.max_participants),
        allow_concurrent: Number(row.allow_concurrent) === 1,
      };
    });
}

async function userPublishedSince(db: Db, userId: number, since: number): Promise<number> {
  const row = await db
    .selectFrom("torrents")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("uploader_id", "=", userId)
    .where("status", "=", "approved")
    .where("deleted_at", "is", null)
    .where("created_at", ">=", since)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function userHnrUnfinished(db: Db, userId: number): Promise<number> {
  const row = await db
    .selectFrom("hnr_obligations")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where("status", "not in", ["reached", "cleared"])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function computeProgress(
  db: Db,
  assessment: ParsedAssessment,
  assignment: Pick<AssignmentRow, "id" | "user_id" | "begin_at" | "end_at" | "baseline_json">,
): Promise<{
  passed: boolean;
  rows: { metric: string; current: number; target: number }[];
  display: AssessmentProgressItem[];
}> {
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", Number(assignment.user_id))
    .executeTakeFirst();
  if (!user) {
    return { passed: false, rows: [], display: [] };
  }
  const baseline = parseJson<{ uploaded?: number; downloaded?: number; bonus?: number; seedtime?: number }>(
    assignment.baseline_json,
    {},
  );
  const ratio = Number(user.downloaded) > 0 ? Number(user.uploaded) / Number(user.downloaded) : 9999;
  const lastActiveDays =
    user.last_seen_at === null
      ? 9999
      : Math.max(0, Math.floor((Date.now() - Number(user.last_seen_at)) / 86_400_000));
  const published = await userPublishedSince(db, Number(user.id), Number(assignment.begin_at));
  const hnr = await userHnrUnfinished(db, Number(user.id));

  const rows: { metric: string; current: number; target: number }[] = [];
  const display: AssessmentProgressItem[] = [];
  let passCount = 0;

  for (const requirement of assessment.requirements.items) {    let current: number;
    switch (requirement.metric) {
      case "uploaded_delta":
        current = Math.max(0, Number(user.uploaded) - Number(baseline.uploaded ?? user.uploaded));
        break;
      case "downloaded_delta":
        current = Math.max(0, Number(user.downloaded) - Number(baseline.downloaded ?? user.downloaded));
        break;
      case "seedtime_delta":
        current = Math.max(0, Number(user.seedtime) - Number(baseline.seedtime ?? user.seedtime));
        break;
      case "bonus_delta":
        current = Math.max(0, Number(user.bonus) - Number(baseline.bonus ?? user.bonus));
        break;
      case "published_delta":
        current = published;
        break;
      case "ratio":
        current = ratio;
        break;
      case "last_active_days":
        current = lastActiveDays;
        break;
      case "warnings":
        current = Number(user.warnings ?? 0);
        break;
      case "hnr_unfinished":
        current = hnr;
        break;
      default:
        current = 0;
    }
    const target = requirementTarget(requirement);
    const progress = progressDisplay(requirement, current, target);
    rows.push(rawProgress(requirement, current, target));
    display.push(progress);
    if (compare(current, requirement.op, target)) passCount += 1;
  }

  const passed =
    assessment.requirements.logic === "all"
      ? passCount === assessment.requirements.items.length
      : passCount > 0;
  return { passed, rows, display };
}

function toAssignmentItem(
  assignment: AssignmentRow,
  assessment: ParsedAssessment,
  display: AssessmentProgressItem[],
): AssessmentAssignmentItem {
  return {
    id: Number(assignment.id),
    token: assignment.token,
    assessment_id: Number(assignment.assessment_id),
    name: assessment.row.name,
    type: assessment.row.type as "exam" | "task",
    description_markdown: assessment.row.description_markdown,
    status: assignment.status as AssessmentAssignmentItem["status"],
    begin_at: Number(assignment.begin_at),
    end_at: Number(assignment.end_at),
    progress: display,
    reward: assessment.reward,
    penalty: assessment.penalty,
    result_reason: assignment.result_reason,
    completed_at: assignment.completed_at === null ? null : Number(assignment.completed_at),
  };
}

export async function refreshAssignmentProgress(
  db: Db,
  assignmentId: number,
): Promise<{
  passed: boolean;
  assignment: AssignmentRow;
  assessment: ParsedAssessment;
  display: AssessmentProgressItem[];
} | null> {
  const assignment = await db
    .selectFrom("assessment_assignments")
    .selectAll()
    .where("id", "=", assignmentId)
    .executeTakeFirst();
  if (!assignment || !ACTIVE_STATUSES.includes(assignment.status as never)) return null;
  const assessmentRow = await getAssessment(db, Number(assignment.assessment_id));
  if (!assessmentRow) return null;
  const assessment = parseAssessment(assessmentRow);
  const computed = await computeProgress(db, assessment, assignment);
  const now = Date.now();

  await db.deleteFrom("assessment_progress").where("assignment_id", "=", assignmentId).execute();
  if (computed.rows.length > 0) {
    await db
      .insertInto("assessment_progress")
      .values(
        computed.rows.map((row) => ({
          assignment_id: assignmentId,
          metric: row.metric,
          baseline_value: 0,
          current_value: row.current,
          target_value: row.target,
          updated_at: now,
        })),
      )
      .execute();
  }
  await db
    .updateTable("assessment_assignments")
    .set({ progress_json: JSON.stringify(computed.display), updated_at: now })
    .where("id", "=", assignmentId)
    .execute();

  return { passed: computed.passed, assignment, assessment, display: computed.display };
}

async function applyReward(
  trx: DbLike,
  assignment: AssignmentRow,
  reward: AssessmentReward,
  now: number,
): Promise<void> {
  const userId = Number(assignment.user_id);
  if (reward.bonus > 0) {
    const user = await trx.selectFrom("users").select("bonus").where("id", "=", userId).executeTakeFirst();
    const balance = Number(user?.bonus ?? 0) + reward.bonus;
    await trx.updateTable("users").set({ bonus: balance }).where("id", "=", userId).execute();
    await trx
      .insertInto("bonus_ledger")
      .values({
        user_id: userId,
        kind: "assessment",
        delta: reward.bonus,
        balance_after: balance,
        ref_type: "assessment_assignment",
        ref_id: String(assignment.id),
        note: `考核/任务奖励（${String(assignment.assessment_id)}）`,
        created_at: now,
      })
      .execute();
  }
  if (reward.invite > 0) {
    await trx
      .updateTable("users")
      .set((eb) => ({ invite_balance: eb("invite_balance", "+", reward.invite) }))
      .where("id", "=", userId)
      .execute();
  }
  if (reward.custom_title) {
    await trx.updateTable("users").set({ custom_title: reward.custom_title }).where("id", "=", userId).execute();
  }
  if (reward.class_slug) {
    const currentUser = await trx.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
    const target = await loadClassBySlug(trx, reward.class_slug);
    if (currentUser && target && Number(target.id) !== Number(currentUser.class_id)) {
      const from = currentUser.class_id === null ? null : await loadClassById(trx, Number(currentUser.class_id));
      await applyClassChange(trx, {
        user: { id: userId, class_id: currentUser.class_id, username: currentUser.username },
        fromClass: from,
        toClass: target,
        source: "system",
        reason: "考核/任务奖励",
        actorId: null,
        now,
      });
    }
  }
}

async function applyPenalty(
  trx: DbLike,
  assignment: AssignmentRow,
  penalty: AssessmentPenalty,
  now: number,
): Promise<void> {
  const userId = Number(assignment.user_id);
  const user = await trx.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
  if (!user) return;

  if (penalty.bonus > 0) {
    const actual = Math.min(Number(user.bonus), penalty.bonus);
    const balance = Number(user.bonus) - actual;
    await trx.updateTable("users").set({ bonus: balance }).where("id", "=", userId).execute();
    await trx
      .insertInto("bonus_ledger")
      .values({
        user_id: userId,
        kind: "assessment",
        delta: -actual,
        balance_after: balance,
        ref_type: "assessment_assignment",
        ref_id: String(assignment.id),
        note: `考核/任务处罚（${String(assignment.assessment_id)}）`,
        created_at: now,
      })
      .execute();
  }
  if (penalty.invite > 0) {
    const actual = Math.min(Number(user.invite_balance), penalty.invite);
    await trx.updateTable("users").set({ invite_balance: Number(user.invite_balance) - actual }).where("id", "=", userId).execute();
  }
  if (penalty.warn > 0) {
    await trx.updateTable("users").set({ warnings: Number(user.warnings ?? 0) + penalty.warn }).where("id", "=", userId).execute();
  }
  if (penalty.class_slug) {
    const target = await loadClassBySlug(trx, penalty.class_slug);
    const current = user.class_id === null ? null : await loadClassById(trx, Number(user.class_id));
    if (target && current && Number(target.rank) < Number(current.rank)) {
      await applyClassChange(trx, {
        user: { id: userId, class_id: user.class_id, username: user.username },
        fromClass: current,
        toClass: target,
        source: "system",
        reason: "考核/任务处罚",
        actorId: null,
        now,
      });
    }
  }
  if (penalty.ban) {
    await trx
      .updateTable("users")
      .set({ status: "banned", suspended_until: null })
      .where("id", "=", userId)
      .execute();
  } else if (penalty.suspend_days > 0) {
    await trx
      .updateTable("users")
      .set({ status: "suspended", suspended_until: now + penalty.suspend_days * 86_400_000 })
      .where("id", "=", userId)
      .execute();
  }
  if (penalty.ban || penalty.suspend_days > 0) {
    await trx.deleteFrom("sessions").where("user_id", "=", userId).execute();
  }
}

export async function settleAssignment(db: Db, assignmentId: number, force = false): Promise<boolean> {
  const refreshed = await refreshAssignmentProgress(db, assignmentId);
  if (!refreshed) return false;
  const now = Date.now();
  if (!refreshed.passed && Number(refreshed.assignment.end_at) > now && !force) return false;

  const status = refreshed.passed ? "passed" : "failed";
  const reason = refreshed.passed ? "满足全部考核条件" : "未在截止时间前满足考核条件";
  let settled = false;
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("assessment_assignments")
      .set({
        status,
        result_reason: reason,
        completed_at: now,
        reward_applied: refreshed.passed ? 1 : 0,
        penalty_applied: refreshed.passed ? 0 : 1,
        updated_at: now,
      })
      .where("id", "=", assignmentId)
      .where("status", "in", [...ACTIVE_STATUSES])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) return;
    if (refreshed.passed) {
      await applyReward(trx, refreshed.assignment, refreshed.assessment.reward, now);
    } else {
      await applyPenalty(trx, refreshed.assignment, refreshed.assessment.penalty, now);
    }
    await trx
      .insertInto("audit_logs")
      .values({
        actor_id: null,
        action: "assessment.checkout",
        target_type: "assessment_assignment",
        target_id: String(assignmentId),
        detail_json: JSON.stringify({ status, reason }),
        ip: null,
        created_at: now,
      })
      .execute();
    settled = true;
  });

  if (settled) {
    await createNotification(db, {
      userId: Number(refreshed.assignment.user_id),
      kind: "assessment",
      title: refreshed.passed ? "考核/任务已完成" : "考核/任务未通过",
      body: refreshed.passed
        ? `你已完成「${refreshed.assessment.row.name}」。`
        : `你未完成「${refreshed.assessment.row.name}」。${refreshed.assessment.penalty.ban ? "账号已被封禁。" : ""}`,
      linkUrl: `/assessments/${String(assignmentId)}`,
    });
  }
  return settled;
}

export async function updateActiveAssessments(db: Db): Promise<number> {
  const now = Date.now();
  const rows = await db
    .selectFrom("assessment_assignments")
    .select("id")
    .where("status", "in", [...ACTIVE_STATUSES])
    .where("end_at", ">", now)
    .limit(500)
    .execute();
  let updated = 0;
  for (const row of rows) {
    const refreshed = await refreshAssignmentProgress(db, Number(row.id));
    if (!refreshed) continue;
    updated += 1;
    if (refreshed.passed && refreshed.assessment.row.settle_early === 1) {
      await settleAssignment(db, Number(row.id));
    }
  }
  return updated;
}

export async function checkoutDueAssessments(db: Db): Promise<number> {
  const now = Date.now();
  const rows = await db
    .selectFrom("assessment_assignments")
    .select("id")
    .where("status", "in", [...ACTIVE_STATUSES])
    .where("end_at", "<=", now)
    .limit(500)
    .execute();
  let settled = 0;
  for (const row of rows) {
    if (await settleAssignment(db, Number(row.id), true)) settled += 1;
  }
  return settled;
}

export async function restoreSuspendedUsers(db: Db): Promise<number> {
  const result = await db
    .updateTable("users")
    .set({ status: "active", suspended_until: null })
    .where("status", "=", "suspended")
    .where("suspended_until", "is not", null)
    .where("suspended_until", "<=", Date.now())
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/** NexusPHP 风格的“自动发现”扫描：给没有进行中考核的用户分配 active exam。 */
export async function autoAssignAssessments(db: Db): Promise<number> {
  const assessments = await db
    .selectFrom("assessments")
    .selectAll()
    .where("status", "=", "active")
    .where("type", "=", "exam")
    .where("auto_assign", "=", 1)
    .orderBy("priority", "desc")
    .orderBy("id", "asc")
    .execute();
  let assigned = 0;
  for (const row of assessments) {
    const assessment = parseAssessment(row);
    if (assessment.row.recurring !== "none") continue;
    const users = await resolveAssessmentUsers(db, assessment.filters);
    for (const user of users) {
      const alreadyAssigned = await db
        .selectFrom("assessment_assignments")
        .select("id")
        .where("assessment_id", "=", Number(assessment.row.id))
        .where("user_id", "=", user.id)
        .executeTakeFirst();
      if (alreadyAssigned) continue;
      const activeExam = await db
        .selectFrom("assessment_assignments as a")
        .innerJoin("assessments as s", "s.id", "a.assessment_id")
        .select("a.id")
        .where("a.user_id", "=", user.id)
        .where("a.status", "in", [...ACTIVE_STATUSES])
        .where("s.type", "=", "exam")
        .executeTakeFirst();
      if (activeExam) continue;
      try {
        await createAssignment(db, assessment, Number(user.id), null, "assign");
        assigned += 1;
      } catch {
        // 已分配、人数满、筛选变化等都不阻塞其他用户
      }
    }
  }
  return assigned;
}

export async function resolveAssessmentUsers(
  db: Db,
  filters: Record<string, unknown>,
): Promise<{ id: number; username: string }[]> {
  const classSlugs = Array.isArray(filters.class_slugs)
    ? filters.class_slugs.filter((item): item is string => typeof item === "string")
    : [];
  let classIds: number[] | null = null;
  if (classSlugs.length > 0) {
    const classes = await db.selectFrom("classes").select(["id", "slug"]).where("slug", "in", classSlugs).execute();
    if (classes.length !== classSlugs.length) throw badRequest("class_not_found", "筛选等级不存在");
    classIds = classes.map((row) => Number(row.id));
  }
  const userIds = Array.isArray(filters.user_ids)
    ? filters.user_ids.filter((item): item is number => typeof item === "number" && item > 0)
    : [];
  const now = Date.now();
  let query = db.selectFrom("users").select(["id", "username"]).where("status", "=", "active");
  if (classIds) query = query.where("class_id", "in", classIds);
  if (userIds.length > 0) query = query.where("id", "in", userIds);
  const registerDays = filters.register_days as { min?: number; max?: number } | undefined;
  if (registerDays?.min !== undefined) {
    query = query.where("created_at", "<=", now - registerDays.min * 86_400_000);
  }
  if (registerDays?.max !== undefined) {
    query = query.where("created_at", ">=", now - registerDays.max * 86_400_000);
  }
  if (typeof filters.last_active_days === "number") {
    query = query.where("last_seen_at", ">=", now - filters.last_active_days * 86_400_000);
  }
  return query.orderBy("id", "asc").execute();
}

export async function createAssignment(
  db: Db,
  assessment: ParsedAssessment,
  userId: number,
  assignedBy: number | null,
  source: "claim" | "assign" = "assign",
): Promise<AssignmentRow> {
  if (assessment.row.recurring !== "none") {
    throw badRequest("recurring_not_supported", "周期考核暂未开放");
  }
  if (assessment.row.status !== "active") throw badRequest("assessment_not_active", "考核/任务未启用");
  const now = Date.now();
  if (assessment.row.end_at !== null && Number(assessment.row.end_at) <= now) {
    throw badRequest("assessment_ended", "考核/任务已结束");
  }
  const existingAssignments = await db
    .selectFrom("assessment_assignments")
    .select(["id", "period_key"])
    .where("assessment_id", "=", Number(assessment.row.id))
    .where("user_id", "=", userId)
    .execute();
  if (Number(assessment.row.allow_concurrent) === 0 && existingAssignments.length > 0) {
    throw conflict("assessment_already_active", "该考核/任务已在进行中");
  }
  if (Number(assessment.row.max_participants) > 0) {
    const count = await db
      .selectFrom("assessment_assignments")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("assessment_id", "=", Number(assessment.row.id))
      .where("status", "in", [...ACTIVE_STATUSES])
      .executeTakeFirst();
    if (Number(count?.count ?? 0) >= Number(assessment.row.max_participants)) {
      throw conflict("assessment_full", "参与人数已满");
    }
  }
  const beginAt = assessment.row.begin_at && Number(assessment.row.begin_at) > now ? Number(assessment.row.begin_at) : now;
  const endAt =
    assessment.row.end_at ??
    (Number(assessment.row.duration_days) > 0
      ? beginAt + Number(assessment.row.duration_days) * 86_400_000
      : null);
  if (endAt === null || endAt <= beginAt) throw badRequest("invalid_time_range", "考核/任务时间范围无效");
  const existingKeys = new Set(existingAssignments.map((row) => row.period_key));
  let periodKey = "once";
  if (Number(assessment.row.allow_concurrent) === 1) {
    let attempt = 1;
    while (existingKeys.has(attempt === 1 ? "once" : `once:${String(attempt)}`)) attempt += 1;
    periodKey = attempt === 1 ? "once" : `once:${String(attempt)}`;
  }
  const user = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
  if (!user) throw badRequest("user_not_found", "用户不存在");
  const baseline = {
    uploaded: Number(user.uploaded),
    downloaded: Number(user.downloaded),
    bonus: Number(user.bonus),
    seedtime: Number(user.seedtime),
    snapshot_at: now,
  };
  const token = randomBytes(16).toString("hex");
  await db
    .insertInto("assessment_assignments")
    .values({
      token,
      assessment_id: Number(assessment.row.id),
      user_id: userId,
      period_key: periodKey,
      status: source === "claim" ? "claimed" : "assigned",
      assigned_by: assignedBy,
      assigned_at: now,
      begin_at: beginAt,
      end_at: endAt,
      baseline_json: JSON.stringify(baseline),
      progress_json: "[]",
      result_reason: null,
      completed_at: null,
      reward_applied: 0,
      penalty_applied: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const assignment = await db
    .selectFrom("assessment_assignments")
    .selectAll()
    .where("token", "=", token)
    .executeTakeFirstOrThrow();
  await refreshAssignmentProgress(db, Number(assignment.id));
  await createNotification(db, {
    userId,
    kind: "assessment",
    title: source === "claim" ? "任务已领取" : "收到新考核/任务",
    body: `你已获得「${assessment.row.name}」，截止时间：${new Date(endAt).toLocaleString("zh-CN")}。`,
    linkUrl: `/assessments/${String(assignment.id)}`,
  });
  return assignment;
}

export async function listMyAssignments(db: Db, userId: number): Promise<AssessmentAssignmentItem[]> {
  const rows = await db
    .selectFrom("assessment_assignments")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
  const result: AssessmentAssignmentItem[] = [];
  for (const row of rows) {
    const assessmentRow = await getAssessment(db, Number(row.assessment_id));
    if (!assessmentRow) continue;
    const display = parseJson<AssessmentProgressItem[]>(row.progress_json, []);
    result.push(toAssignmentItem(row, parseAssessment(assessmentRow), display));
  }
  return result;
}

export async function getMyAssignment(
  db: Db,
  userId: number,
  assignmentId: number,
): Promise<AssessmentAssignmentItem | null> {
  const row = await db
    .selectFrom("assessment_assignments")
    .selectAll()
    .where("id", "=", assignmentId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return null;
  const assessmentRow = await getAssessment(db, Number(row.assessment_id));
  if (!assessmentRow) return null;
  return toAssignmentItem(row, parseAssessment(assessmentRow), parseJson<AssessmentProgressItem[]>(row.progress_json, []));
}

export async function listParticipants(
  db: Db,
  assessmentId: number,
): Promise<StaffAssessmentParticipant[]> {
  const rows = await db
    .selectFrom("assessment_assignments as a")
    .innerJoin("users as u", "u.id", "a.user_id")
    .select([
      "a.id as id",
      "a.user_id as user_id",
      "u.username as username",
      "a.status as status",
      "a.begin_at as begin_at",
      "a.end_at as end_at",
      "a.progress_json as progress_json",
      "a.result_reason as result_reason",
      "a.completed_at as completed_at",
    ])
    .where("a.assessment_id", "=", assessmentId)
    .orderBy("a.id", "desc")
    .execute();
  return rows.map((row) => ({
    assignment_id: Number(row.id),
    user_id: Number(row.user_id),
    username: row.username,
    status: row.status as StaffAssessmentParticipant["status"],
    begin_at: Number(row.begin_at),
    end_at: Number(row.end_at),
    progress: parseJson<AssessmentProgressItem[]>(row.progress_json, []),
    result_reason: row.result_reason,
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
  }));
}

export function validateAssessmentBody(body: StaffAssessmentBody): void {
  if (body.recurring !== "none") throw badRequest("recurring_not_supported", "周期考核暂未开放");
  if (body.auto_assign && body.type !== "exam") {
    throw badRequest("auto_assign_exam_only", "只有考核可以开启自动发现");
  }
  if (body.end_at !== null && body.end_at !== undefined && body.end_at <= Date.now()) {
    throw badRequest("invalid_time_range", "结束时间必须晚于当前时间");
  }
  if (body.begin_at && body.end_at && body.begin_at >= body.end_at) {
    throw badRequest("invalid_time_range", "开始时间必须早于结束时间");
  }
  if (!body.begin_at && !body.end_at && body.duration_days <= 0) {
    throw badRequest("invalid_time_range", "必须设置结束时间或领取时长");
  }
  for (const item of body.requirements.items) {
    if (item.metric === "uploaded_delta" || item.metric === "downloaded_delta") {
      if (item.unit !== "GB") throw badRequest("invalid_unit", "流量指标单位必须为 GB");
    } else if (item.unit !== undefined) {
      throw badRequest("invalid_unit", "只有流量指标可以使用 GB");
    }
  }
}

export async function createAssessmentRecord(
  db: Db,
  body: StaffAssessmentBody,
  actorId: number,
): Promise<StaffAssessmentItem> {
  validateAssessmentBody(body);
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  await db
    .insertInto("assessments")
    .values({
      token,
      name: body.name,
      description_markdown: body.description_markdown ?? null,
      type: body.type,
      status: body.status,
      begin_at: body.begin_at ?? null,
      end_at: body.end_at ?? null,
      duration_days: body.duration_days,
      recurring: body.recurring,
      filters_json: JSON.stringify(body.filters ?? {}),
      requirements_json: JSON.stringify(body.requirements),
      success_reward_json: JSON.stringify(body.reward),
      failure_penalty_json: JSON.stringify(body.penalty),
      max_participants: body.max_participants,
      allow_concurrent: body.allow_concurrent ? 1 : 0,
      settle_early: body.settle_early ? 1 : 0,
      auto_assign: body.auto_assign ? 1 : 0,
      priority: body.priority,
      created_by: actorId,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const row = await db
    .selectFrom("assessments")
    .selectAll()
    .where("token", "=", token)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("audit_logs")
    .values({
      actor_id: actorId,
      action: "assessment.create",
      target_type: "assessment",
      target_id: String(row.id),
      detail_json: JSON.stringify({ name: body.name, type: body.type }),
      ip: null,
      created_at: now,
    })
    .execute();
  return toStaffAssessment(db, row);
}

export async function updateAssessmentRecord(
  db: Db,
  id: number,
  body: StaffAssessmentBody,
): Promise<StaffAssessmentItem | null> {
  validateAssessmentBody(body);
  const existing = await db.selectFrom("assessments").select("id").where("id", "=", id).executeTakeFirst();
  if (!existing) return null;
  await db
    .updateTable("assessments")
    .set({
      name: body.name,
      description_markdown: body.description_markdown ?? null,
      type: body.type,
      status: body.status,
      begin_at: body.begin_at ?? null,
      end_at: body.end_at ?? null,
      duration_days: body.duration_days,
      recurring: body.recurring,
      filters_json: JSON.stringify(body.filters ?? {}),
      requirements_json: JSON.stringify(body.requirements),
      success_reward_json: JSON.stringify(body.reward),
      failure_penalty_json: JSON.stringify(body.penalty),
      max_participants: body.max_participants,
      allow_concurrent: body.allow_concurrent ? 1 : 0,
      settle_early: body.settle_early ? 1 : 0,
      auto_assign: body.auto_assign ? 1 : 0,
      priority: body.priority,
      updated_at: Date.now(),
    })
    .where("id", "=", id)
    .execute();
  const row = await getAssessment(db, id);
  return row ? toStaffAssessment(db, row) : null;
}
