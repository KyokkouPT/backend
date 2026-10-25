import { z } from "zod";

/**
 * 共享契约（DTO / zod schema）。
 *
 * 这个包在 backend/vendor/contracts 与 frontend/vendor/contracts 各存一份，
 * 内容必须保持一致；改完一边要复制到另一边，并让两边各自 typecheck。
 * 详细同步规则见两个仓库的 README。
 */

/** REST API 前缀；Tracker / RSS / 下载在根路径。 */
export const API_PREFIX = "/api/v1";

/** GET /api/v1/health */
export const healthResponse = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

/** RFC 7807 problem+json 的错误体。 */
export const problemField = z.object({
  path: z.string(),
  message: z.string(),
});
export type ProblemField = z.infer<typeof problemField>;

export const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  request_id: z.string().optional(),
  fields: z.array(problemField).optional(),
});
export type Problem = z.infer<typeof problem>;

/** 用户角色与状态；权限必须在后端校验，前端只用于显示/路由守卫。 */
export const role = z.enum(["user", "moderator", "admin"]);
export type Role = z.infer<typeof role>;

export const userStatus = z.enum(["active", "suspended", "banned"]);
export type UserStatus = z.infer<typeof userStatus>;

/** 权限 key 常量；后续纵切按需追加，不在前端硬编码字符串。 */
export const PERMISSIONS = {
  staffAccess: "staff.access",
  staffReview: "staff.review",
  staffReports: "staff.reports",
  staffUsers: "staff.users",
  staffAnomalies: "staff.anomalies",
  staffAudit: "staff.audit",
  staffSettings: "staff.settings",
  staffSections: "staff.sections",
  staffAppeals: "staff.appeals",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 列表分页响应的通用外壳；items 由各端点自己定义。 */
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
};
