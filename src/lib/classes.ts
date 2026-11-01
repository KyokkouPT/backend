import type { Selectable } from "kysely";
import {
  PERMISSIONS,
  type ClassBrief,
  type ClassCondition,
  type ClassRule,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import type { ClassesTable, UserPermissionOverridesTable, UsersTable } from "../db/types.js";
import { DEFAULT_CLASS_SLUG } from "./class-defaults.js";

export type ClassRow = Selectable<ClassesTable>;
export type OverrideRow = Selectable<UserPermissionOverridesTable>;
export type UserRow = Selectable<UsersTable>;

export type UserMetrics = {
  age_days: number;
  uploaded: number;
  downloaded: number;
  raw_uploaded: number;
  raw_downloaded: number;
  ratio: number;
  seedtime_hours: number;
  bonus: number;
  torrents_published: number;
  invites_used: number;
  warnings: number;
  hnr_unfinished: number;
  last_active_days: number;
};

export const METRIC_LABELS: Record<string, string> = {
  age_days: "注册天数",
  uploaded: "上传量",
  downloaded: "下载量",
  ratio: "分享率",
  seedtime_hours: "做种时长（小时）",
  bonus: "魔力值",
  torrents_published: "发布数",
  invites_used: "已用邀请",
  warnings: "警告次数",
  hnr_unfinished: "未完成 H&R",
  last_active_days: "最近活跃（天）",
};

export const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

export function parsePermissions(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseRule(json: string | null): ClassRule | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { logic?: unknown; conditions?: unknown };
    if (record.logic !== "all" && record.logic !== "any") return null;
    if (!Array.isArray(record.conditions)) return null;
    const conditions: ClassCondition[] = [];
    for (const raw of record.conditions) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as { metric?: unknown; op?: unknown; value?: unknown; unit?: unknown };
      if (typeof item.metric !== "string" || typeof item.op !== "string" || typeof item.value !== "number") continue;
      if (!["", "B", "KB", "MB", "GB", "TB"].includes(typeof item.unit === "string" ? item.unit : "")) continue;
      conditions.push({
        metric: item.metric,
        op: item.op as ClassCondition["op"],
        value: item.value,
        ...(typeof item.unit === "string" ? { unit: item.unit as ClassCondition["unit"] } : {}),
      });
    }
    return { logic: record.logic, conditions };
  } catch {
    return null;
  }
}

export function ruleKey(rule: ClassRule | null): string {
  if (!rule) return "";
  return JSON.stringify({
    logic: rule.logic,
    conditions: rule.conditions
      .map((c) => [c.metric, c.op, c.value, c.unit ?? ""])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
  });
}

export function toClassBrief(row: ClassRow): ClassBrief {
  return {
    slug: row.slug,
    name: row.name,
    rank: Number(row.rank),
    badge: row.badge,
    color: row.color,
  };
}

/** 会话/迁移尚未回填时的兜底展示。 */
export function classBriefOf(row: ClassRow | null, fallbackSlug: string, fallbackName: string): ClassBrief {
  return row
    ? toClassBrief(row)
    : { slug: fallbackSlug, name: fallbackName, rank: 0, badge: null, color: null };
}

export async function loadClassBySlug(db: Db, slug: string): Promise<ClassRow | null> {
  const row = await db.selectFrom("classes").selectAll().where("slug", "=", slug).executeTakeFirst();
  return row ?? null;
}

export async function loadClassById(db: Db, id: number): Promise<ClassRow | null> {
  const row = await db.selectFrom("classes").selectAll().where("id", "=", id).executeTakeFirst();
  return row ?? null;
}

export async function loadAllClasses(db: Db): Promise<ClassRow[]> {
  return db.selectFrom("classes").selectAll().orderBy("rank", "asc").execute();
}

export async function loadOverrides(db: Db, userId: number, now = Date.now()): Promise<OverrideRow[]> {
  return db
    .selectFrom("user_permission_overrides")
    .selectAll()
    .where("user_id", "=", userId)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    .execute();
}

export type PermissionOverride = Pick<OverrideRow, "permission" | "effect" | "expires_at">;

/** staff.available 硬门控：没有它时忽略全部 staff.* 节点。 */
export function gateStaffPermissions(permissions: string[]): string[] {
  if (permissions.includes(PERMISSIONS.staffAvailable)) return permissions;
  return permissions.filter((permission) => !permission.startsWith("staff."));
}

export function computePermissions(
  classRow: ClassRow | null,
  overrides: PermissionOverride[],
  now = Date.now(),
): string[] {
  const set = new Set(classRow ? parsePermissions(classRow.permissions_json) : []);
  for (const override of overrides) {
    if (override.expires_at !== null && Number(override.expires_at) <= now) continue;
    if (override.effect === "grant") set.add(override.permission);
    else set.delete(override.permission);
  }
  return gateStaffPermissions([...set]);
}

/** 校验等级配置：有 staff.* 必须有 staff.available；user_edit 只能授予字段子节点。 */
export function classPermissionError(permissions: string[]): string | null {
  if (permissions.includes("staff.user_edit")) {
    return "staff.user_edit 不能独立授予，请勾选具体字段子权限";
  }
  if (permissions.includes("staff.user_class") || permissions.includes("staff.user_status")) {
    return "请使用 staff.user_edit.class / staff.user_edit.status";
  }
  const hasStaff = permissions.some((permission) => permission.startsWith("staff."));
  if (hasStaff && !permissions.includes(PERMISSIONS.staffAvailable)) {
    return "勾选了 staff.* 权限时必须同时勾选 staff.available";
  }
  return null;
}

/** 条件值换算为字节；上传/下载默认 GB。 */
export function conditionBytes(condition: ClassCondition): number {
  if (condition.metric !== "uploaded" && condition.metric !== "downloaded") return condition.value;
  const unit = condition.unit ?? "GB";
  return condition.value * (UNIT_BYTES[unit] ?? 1024 ** 3);
}

function compare(left: number, op: string, right: number): boolean {
  switch (op) {
    case ">=":
      return left >= right;
    case ">":
      return left > right;
    case "<=":
      return left <= right;
    case "<":
      return left < right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
}

export function conditionSatisfied(condition: ClassCondition, metrics: UserMetrics): boolean {
  const raw = metrics[condition.metric as keyof UserMetrics];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    // 分享率在无下载时为 Infinity，属于满足“大于”条件。
    if (condition.metric === "ratio" && metrics.downloaded <= 0) {
      return condition.op === ">" || condition.op === ">=" || condition.op === "!=";
    }
    return false;
  }
  return compare(raw, condition.op, conditionBytes(condition));
}

export function evaluateRule(rule: ClassRule | null, metrics: UserMetrics): boolean {
  if (!rule || rule.conditions.length === 0) return true;
  return rule.logic === "all"
    ? rule.conditions.every((condition) => conditionSatisfied(condition, metrics))
    : rule.conditions.some((condition) => conditionSatisfied(condition, metrics));
}

export function missingConditions(rule: ClassRule | null, metrics: UserMetrics): string[] {
  if (!rule) return [];
  return rule.conditions
    .filter((condition) => !conditionSatisfied(condition, metrics))
    .map((condition) => {
      const label = METRIC_LABELS[condition.metric] ?? condition.metric;
      const raw = metrics[condition.metric as keyof UserMetrics];
      const current =
        condition.metric === "ratio" && metrics.downloaded <= 0
          ? "∞"
          : typeof raw === "number" && Number.isFinite(raw)
            ? String(Math.round(raw * 100) / 100)
            : "—";
      const target =
        condition.metric === "uploaded" || condition.metric === "downloaded"
          ? `${String(condition.value)} ${condition.unit ?? "GB"}`
          : String(condition.value);
      return `${label}需 ${condition.op} ${target}（当前 ${current}）`;
    });
}

export function isAutoPromote(row: ClassRow): boolean {
  return parsePermissions(row.permissions_json).includes(PERMISSIONS.classAutoPromote);
}

export function isAutoDemote(row: ClassRow): boolean {
  return parsePermissions(row.permissions_json).includes(PERMISSIONS.classAutoDemote);
}

/** 满足条件的最高等级；条件完全相同的多个等级取 rank 最低的。 */
export function pickHighestEligible(classes: ClassRow[], metrics: UserMetrics): ClassRow | null {
  const eligible = classes
    .filter((row) => isAutoPromote(row))
    .filter((row) => {
      const rule = parseRule(row.promote_rule_json);
      return rule !== null && evaluateRule(rule, metrics);
    })
    .sort((a, b) => Number(b.rank) - Number(a.rank));
  if (eligible.length === 0) return null;
  const top = eligible[0] as ClassRow;
  const topKey = ruleKey(parseRule(top.promote_rule_json));
  const sameRule = eligible.filter((row) => ruleKey(parseRule(row.promote_rule_json)) === topKey);
  return (sameRule.sort((a, b) => Number(a.rank) - Number(b.rank))[0] ?? top) as ClassRow;
}

/** 当前等级之上第一个满足条件的自动等级（逐级升，可循环调用）。 */
export function pickNextPromotion(
  classes: ClassRow[],
  currentRank: number,
  metrics: UserMetrics,
): ClassRow | null {
  const candidates = classes
    .filter((row) => Number(row.rank) > currentRank && isAutoPromote(row))
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  for (const row of candidates) {
    const rule = parseRule(row.promote_rule_json);
    if (rule !== null && evaluateRule(rule, metrics)) return row;
  }
  return null;
}

export function nextHigherClass(classes: ClassRow[], currentRank: number): ClassRow | null {
  const higher = classes
    .filter((row) => Number(row.rank) > currentRank)
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  return higher[0] ?? null;
}

export function fallbackClass(classes: ClassRow[]): ClassRow | null {
  return (
    classes.find((row) => row.slug === DEFAULT_CLASS_SLUG) ??
    classes.slice().sort((a, b) => Number(a.rank) - Number(b.rank))[0] ??
    null
  );
}

export function classMatches(classes: ClassRow[], slug: string): ClassRow | null {
  return classes.find((row) => row.slug === slug) ?? null;
}
