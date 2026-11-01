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
  staffAvailable: "staff.available",
  staffAccess: "staff.access",
  staffReview: "staff.review",
  staffReports: "staff.reports",
  staffUsers: "staff.users",
  staffBonusShop: "staff.bonus_shop",
  staffUserEditPassword: "staff.user_edit.password",
  staffUserEditUsername: "staff.user_edit.username",
  staffUserEditEmail: "staff.user_edit.email",
  staffUserEditClass: "staff.user_edit.class",
  staffUserEditStatus: "staff.user_edit.status",
  staffUserEditBonus: "staff.user_edit.bonus",
  staffUserEditUploaded: "staff.user_edit.uploaded",
  staffUserEditDownloaded: "staff.user_edit.downloaded",
  staffUserEditInviteBalance: "staff.user_edit.invite_balance",
  staffUserEditWarnings: "staff.user_edit.warnings",
  staffUserEditCustomTitle: "staff.user_edit.custom_title",
  staffAnomalies: "staff.anomalies",
  staffAudit: "staff.audit",
  staffSettings: "staff.settings",
  staffClasses: "staff.classes",
  staffAppeals: "staff.appeals",
  staffAnnouncement: "staff.announcement",
  staffUserWarn: "staff.user_warn",
  staffInviteView: "staff.invite_view",
  staffIpView: "staff.ip_view",
  staffClassSimulate: "staff.class_simulate",
  staffClassHistory: "staff.class_history",
  classAutoPromote: "class.auto_promote",
  classAutoDemote: "class.auto_demote",
  userDonor: "user.donor",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 列表分页响应的通用外壳；items 由各端点自己定义。 */
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
};

/* ============================ 站点 / 导航 ============================ */

export const siteTheme = z.object({
  default: z.enum(["polar", "aurora"]),
});

export const siteFooter = z.object({
  copyright: z.string(),
  icp: z.string().nullable(),
  disclaimer: z.string(),
  status: z.string(),
});

export const siteRegistration = z.object({
  open: z.boolean(),
  invite_registration_enabled: z.boolean(),
  closed_message: z.string(),
  closed_registration_mode: z.enum(["auto", "form", "message"]),
  invite_require_email: z.boolean(),
});
export type SiteRegistration = z.infer<typeof siteRegistration>;

export const siteIdentity = z.object({
  name: z.string(),
  tagline: z.string(),
  locale: z.string(),
  version: z.string(),
  theme: siteTheme,
  modules: z.record(z.boolean()),
  registration: siteRegistration,
  footer: siteFooter,
});
export type SiteIdentity = z.infer<typeof siteIdentity>;

/** 导航项：图标由前端按 key 映射到 lucide，不在契约里放组件。 */
export const navItem = z.object({
  key: z.string(),
  href: z.string(),
  label: z.string(),
  icon: z.string(),
  exact: z.boolean().optional(),
  badge: z.string().nullable().optional(),
});
export type NavItem = z.infer<typeof navItem>;

export const navGroup = z.object({
  label: z.string().optional(),
  items: z.array(navItem),
});
export type NavGroup = z.infer<typeof navGroup>;

export const siteNav = z.object({
  site: z.array(navGroup),
  staff: z.array(navGroup),
});
export type SiteNav = z.infer<typeof siteNav>;

/* ============================ 分区 / 字段 ============================ */

export const sectionFieldType = z.enum(["text", "select", "multiselect", "number"]);
export type SectionFieldType = z.infer<typeof sectionFieldType>;

export const sectionField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string(),
  type: sectionFieldType,
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  filterable: z.boolean(),
  display_order: z.number().int(),
  hint: z.string().optional(),
});
export type SectionField = z.infer<typeof sectionField>;

export const category = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
});
export type CategoryRef = z.infer<typeof category>;

export const section = z.object({
  slug: z.string(),
  name: z.string(),
  display_order: z.number().int(),
  review_mode: z.string(),
  charter: z.record(z.string()).optional(),
  fields: z.array(sectionField),
  categories: z.array(category),
});
export type Section = z.infer<typeof section>;

/* ============================ 用户 ============================ */

/** 等级的最小展示信息；用于用户摘要、Staff 列表与模拟器。 */
export const classBrief = z.object({
  slug: z.string(),
  name: z.string(),
  rank: z.number().int(),
  badge: z.string().nullable(),
  color: z.string().nullable(),
});
export type ClassBrief = z.infer<typeof classBrief>;

export const userSummary = z.object({
  id: z.number().int(),
  username: z.string(),
  role: role,
  class_key: z.string(),
  class: classBrief,
  status: userStatus,
  uploaded: z.number(),
  downloaded: z.number(),
  /** Tracker 实际累计流量（不打折、不受兑换影响）。 */
  raw_uploaded: z.number(),
  raw_downloaded: z.number(),
  bonus: z.number(),
  /** downloaded 为 0 时无法计算分享率，返回 null（前端展示 ∞ / —）。 */
  ratio: z.number().nullable(),
  seedtime: z.number(),
  created_at: z.number(),
});
export type UserSummary = z.infer<typeof userSummary>;

export const bootstrapCounts = z.object({
  pending_review: z.number().int(),
  open_reports: z.number().int(),
  anomalies: z.number().int(),
  unread: z.number().int(),
});
export type BootstrapCounts = z.infer<typeof bootstrapCounts>;

export const bootstrap = z.object({
  site: siteIdentity,
  nav: siteNav,
  sections: z.array(section),
  permissions: z.array(z.string()),
  counts: bootstrapCounts,
  me: userSummary.nullable(),
  config_version: z.string(),
});
export type Bootstrap = z.infer<typeof bootstrap>;

/* ============================ 种子 / 首页 ============================ */

export const promo = z.enum(["free", "2x", "50", "30", "none"]);
export type Promo = z.infer<typeof promo>;

export const torrentSectionRef = z.object({ slug: z.string(), name: z.string() });
export const torrentCategoryRef = z.object({ slug: z.string(), name: z.string() });
export const torrentUploader = z.object({
  id: z.number().int(),
  name: z.string(),
  hue: z.number().int(),
});

export const torrentSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  section: torrentSectionRef,
  category: torrentCategoryRef,
  uploader: torrentUploader.nullable(),
  size: z.number(),
  files_count: z.number().int(),
  promo,
  seeders: z.number().int(),
  leechers: z.number().int(),
  completed: z.number().int(),
  created_at: z.number(),
  tags: z.array(z.string()),
  meta: z.record(z.union([z.string(), z.number(), z.boolean()])),
  zero_bonus: z.boolean(),
  owned: z.boolean(),
  download_url: z.string(),
});
export type TorrentSummary = z.infer<typeof torrentSummary>;

export const announcement = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  author: z.string().nullable(),
  pinned: z.boolean(),
  tone: z.enum(["info", "warn"]),
  created_at: z.number(),
});
export type Announcement = z.infer<typeof announcement>;

export const promoEvent = z.object({
  id: z.number().int(),
  name: z.string(),
  scope: z.string(),
  promo: z.string(),
  starts_at: z.number().nullable(),
  ends_at: z.number().nullable(),
});
export type PromoEvent = z.infer<typeof promoEvent>;

export const homeStats = z.object({
  users: z.number().int(),
  torrents: z.number().int(),
  seeders: z.number().int(),
  leechers: z.number().int(),
  peers: z.number().int(),
  new_today: z.number().int(),
});
export type HomeStats = z.infer<typeof homeStats>;

export const homeResponse = z.object({
  stats: homeStats,
  latest: z.array(torrentSummary),
  announcements: z.array(announcement),
  promos: z.array(promoEvent),
  my: z
    .object({
      unread: z.number().int(),
      hnr_due: z.number().int(),
    })
    .nullable(),
});
export type HomeResponse = z.infer<typeof homeResponse>;

/* ============================ 认证 / 我的 / 规则 ============================ */

export const csrfResponse = z.object({ csrf_token: z.string() });
export type CsrfResponse = z.infer<typeof csrfResponse>;

export const loginRequest = z.object({
  username: z.string().min(1).max(190),
  password: z.string().min(1).max(200),
  totp_code: z.string().max(16).optional(),
  recovery_code: z.string().max(64).optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const loginResponse = z.object({
  user: userSummary,
  csrf_token: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponse>;

export const authMeResponse = z.object({
  user: userSummary,
  permissions: z.array(z.string()),
  unread_count: z.number().int(),
  todo: z.object({ pending_review: z.number().int() }),
});
export type AuthMeResponse = z.infer<typeof authMeResponse>;

export const hnrItem = z.object({
  id: z.number().int(),
  torrent_id: z.number().int(),
  name: z.string(),
  deadline_at: z.number(),
  required_seconds: z.number().int(),
  seeded_seconds: z.number().int(),
  status: z.string(),
  resolved_at: z.number().nullable(),
});

export const snatchItem = z.object({
  torrent_id: z.number().int(),
  name: z.string(),
  uploaded: z.number(),
  downloaded: z.number(),
  seedtime: z.number(),
  last_announce_at: z.number().nullable(),
  status: z.string(),
});

export const meResponse = z.object({
  user: userSummary,
  stats: z.object({
    seeding: z.number().int(),
    leeching: z.number().int(),
    published: z.number().int(),
  }),
  hnr: z.array(hnrItem),
  hnr_credits: z.number().int(),
  snatches: z.array(snatchItem),
  rss_url: z.string(),
  bonus_yield_per_hour: z.number(),
  bonus_frozen_until: z.number().nullable(),
});
export type MeResponse = z.infer<typeof meResponse>;

export const rulesSection = z.object({
  slug: z.string(),
  name: z.string(),
  review_mode: z.string(),
  charter: z.record(z.string()).optional(),
  fields: z.array(sectionField),
});

export const rulesResponse = z.object({
  registration: siteRegistration,
  review: z.object({
    auto_approve_trusted: z.boolean(),
    trusted_min_approved: z.number().int(),
    pending_alert_hours: z.number().int(),
  }),
  tracker: z.object({
    announce_interval: z.number().int(),
    min_interval: z.number().int(),
  }),
  hnr: z.object({
    enabled: z.boolean(),
    seed_seconds: z.number().int(),
    deadline_days: z.number().int(),
  }),
  sections: z.array(rulesSection),
});
export type RulesResponse = z.infer<typeof rulesResponse>;

/* ============================ 目录 / 上传 / 审核 / 通知 ============================ */

export const torrentListResponse = z.object({
  items: z.array(torrentSummary),
  next_cursor: z.string().nullable(),
});
export type TorrentListResponse = z.infer<typeof torrentListResponse>;

export const torrentFile = z.object({ path: z.string(), size: z.number() });
export type TorrentFile = z.infer<typeof torrentFile>;

export const torrentDetail = torrentSummary.extend({
  info_hash: z.string(),
  description: z.string().nullable(),
  files: z.array(torrentFile),
  related: z.array(torrentSummary),
});
export type TorrentDetail = z.infer<typeof torrentDetail>;

export const uploadResponse = z.object({
  id: z.number().int(),
  status: z.enum(["pending", "approved", "rejected"]),
  message: z.string(),
});
export type UploadResponse = z.infer<typeof uploadResponse>;

export const zeroBonusBody = z.object({ zero_bonus: z.boolean() });
export type ZeroBonusBody = z.infer<typeof zeroBonusBody>;

export const zeroBonusResponse = z.object({ ok: z.boolean(), zero_bonus: z.boolean() });
export type ZeroBonusResponse = z.infer<typeof zeroBonusResponse>;

export const bonusFormulaTorrentTerm = z.object({
  id: z.number().int(),
  size_gb: z.number(),
  age_weeks: z.number(),
  seeders: z.number().int(),
  weight: z.number(),
  term: z.number(),
});
export type BonusFormulaTorrentTerm = z.infer<typeof bonusFormulaTorrentTerm>;

export const bonusFormulaSample = z.object({
  label: z.string(),
  seeders: z.number().int(),
  total_gb: z.number(),
  result: z.number(),
});
export type BonusFormulaSample = z.infer<typeof bonusFormulaSample>;

export const bonusFormulaPreviewBody = z.object({
  formula: z.string().min(1).max(2000),
});
export type BonusFormulaPreviewBody = z.infer<typeof bonusFormulaPreviewBody>;

export const bonusFormulaPreviewResponse = z.object({
  result: z.number(),
  variables: z.record(z.number()),
  samples: z.array(bonusFormulaSample),
  torrents: z.array(bonusFormulaTorrentTerm),
  warnings: z.array(z.string()),
});
export type BonusFormulaPreviewResponse = z.infer<typeof bonusFormulaPreviewResponse>;

export const bonusFormulaSimulateBody = z.object({
  formula: z.string().min(1).max(2000),
  user_id: z.number().int().positive(),
});
export type BonusFormulaSimulateBody = z.infer<typeof bonusFormulaSimulateBody>;

export const bonusFormulaSimulateResponse = z.object({
  user_id: z.number().int(),
  username: z.string(),
  result: z.number(),
  variables: z.record(z.number()),
  torrents: z.array(bonusFormulaTorrentTerm),
  warnings: z.array(z.string()),
});
export type BonusFormulaSimulateResponse = z.infer<typeof bonusFormulaSimulateResponse>;

export const reviewReason = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
});
export type ReviewReason = z.infer<typeof reviewReason>;

export const reviewReasonsResponse = z.object({ reasons: z.array(reviewReason) });
export type ReviewReasonsResponse = z.infer<typeof reviewReasonsResponse>;

export const reviewQueueResponse = z.object({ items: z.array(torrentDetail) });
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponse>;

export const reviewActionResponse = z.object({ ok: z.boolean(), status: z.string() });
export type ReviewActionResponse = z.infer<typeof reviewActionResponse>;

export const notificationItem = z.object({
  id: z.number().int(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  link_url: z.string().nullable(),
  read_at: z.number().nullable(),
  created_at: z.number(),
});
export type NotificationItem = z.infer<typeof notificationItem>;

export const notificationsResponse = z.object({
  items: z.array(notificationItem),
  unread: z.number().int(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponse>;

/* ============================ 经济 / RSS ============================ */

export const ledgerEntry = z.object({
  id: z.number().int(),
  kind: z.string(),
  delta: z.number(),
  balance_after: z.number(),
  note: z.string().nullable(),
  created_at: z.number(),
});
export type LedgerEntry = z.infer<typeof ledgerEntry>;

export const exchangeDirection = z.enum(["buy", "sell"]);
export type ExchangeDirection = z.infer<typeof exchangeDirection>;

export const exchangeType = z.enum([
  "upload_add",
  "download_add",
  "download_reduce",
  "invite_add",
  "title_set",
  "gift_bonus",
  "username_change",
  "hnr_clear",
  "invite_sell",
  "upload_sell",
]);
export type ExchangeType = z.infer<typeof exchangeType>;

export const exchangeRequirement = z.enum(["title", "recipient", "message", "username"]);
export type ExchangeRequirement = z.infer<typeof exchangeRequirement>;

export const exchangeItem = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  direction: exchangeDirection,
  type: exchangeType,
  amount: z.number().nullable(),
  params: z.record(z.string(), z.unknown()),
  requires: z.array(exchangeRequirement),
  price: z.number(),
  inventory: z.number().nullable(),
  limit_per_user: z.number().nullable(),
  remaining: z.number().int().nullable(),
  user_remaining: z.number().int().nullable(),
  affordable: z.boolean(),
  enabled: z.boolean(),
  display_order: z.number().int(),
  min_class_rank: z.number().int().nullable(),
});
export type ExchangeItem = z.infer<typeof exchangeItem>;

export const bonusResponse = z.object({
  balance: z.number(),
  yield_per_hour: z.number(),
  frozen_until: z.number().nullable(),
  ledger: z.array(ledgerEntry),
  items: z.array(exchangeItem),
});
export type BonusResponse = z.infer<typeof bonusResponse>;

export const exchangeBody = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().max(64).optional(),
});
export type ExchangeBody = z.infer<typeof exchangeBody>;

export const exchangeResponse = z.object({
  ok: z.boolean(),
  balance: z.number(),
  item_key: z.string(),
  redemption_id: z.number().int(),
  status: z.enum(["completed"]),
  message: z.string(),
});
export type ExchangeResponse = z.infer<typeof exchangeResponse>;

export const redemptionItem = z.object({
  id: z.number().int(),
  item_id: z.number().int(),
  item_key: z.string().nullable(),
  type: z.string(),
  status: z.enum(["completed", "failed"]),
  price: z.number(),
  params: z.record(z.string(), z.unknown()),
  actor: z.string().nullable(),
  created_at: z.number(),
});
export type RedemptionItem = z.infer<typeof redemptionItem>;

export const redemptionsResponse = z.object({ items: z.array(redemptionItem) });
export type RedemptionsResponse = z.infer<typeof redemptionsResponse>;

export const hnrCreditsResponse = z.object({
  credits: z.number().int(),
  next_expires_at: z.number().nullable(),
});
export type HnrCreditsResponse = z.infer<typeof hnrCreditsResponse>;

export const clearHnrResponse = z.object({
  ok: z.literal(true),
  credits: z.number().int(),
  message: z.string(),
});
export type ClearHnrResponse = z.infer<typeof clearHnrResponse>;

export const staffExchangeItem = z.object({
  id: z.number().int(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  direction: exchangeDirection,
  type: z.string(),
  amount: z.number().nullable(),
  params: z.record(z.string(), z.unknown()),
  price: z.number(),
  inventory: z.number().nullable(),
  limit_per_user: z.number().nullable(),
  enabled: z.boolean(),
  display_order: z.number().int(),
  min_class_rank: z.number().int().nullable(),
  used: z.number().int(),
  remaining: z.number().int().nullable(),
});
export type StaffExchangeItem = z.infer<typeof staffExchangeItem>;

export const staffExchangeItemsResponse = z.object({ items: z.array(staffExchangeItem) });
export type StaffExchangeItemsResponse = z.infer<typeof staffExchangeItemsResponse>;

const staffExchangeBaseBody = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).nullable().optional(),
  direction: exchangeDirection,
  type: exchangeType,
  amount: z.number().int().positive().nullable().optional(),
  price: z.number().min(0),
  params: z.record(z.string(), z.unknown()).optional(),
  inventory: z.number().int().positive().nullable().optional(),
  limit_per_user: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  display_order: z.number().int().optional(),
  min_class_rank: z.number().int().min(0).nullable().optional(),
});

export const staffExchangeItemCreateBody = staffExchangeBaseBody.extend({
  key: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9_]+$/, "key 只能包含字母、数字和下划线"),
});
export type StaffExchangeItemCreateBody = z.infer<typeof staffExchangeItemCreateBody>;

export const staffExchangeItemUpdateBody = staffExchangeBaseBody;
export type StaffExchangeItemUpdateBody = z.infer<typeof staffExchangeItemUpdateBody>;

export const ledgerResponse = z.object({ items: z.array(ledgerEntry) });
export type LedgerResponse = z.infer<typeof ledgerResponse>;

export const rssResponse = z.object({ url: z.string() });
export type RssResponse = z.infer<typeof rssResponse>;

/* ============================ 社区 ============================ */

export const inviteItem = z.object({
  code: z.string(),
  status: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  used_at: z.number().nullable(),
  invited_user: z.string().nullable(),
  email: z.string().nullable(),
});
export type InviteItem = z.infer<typeof inviteItem>;

export const inviteCreateBody = z.object({
  email: z.string().email().max(190).optional(),
});
export type InviteCreateBody = z.infer<typeof inviteCreateBody>;

export const invitesResponse = z.object({
  items: z.array(inviteItem),
  quota_used: z.number().int(),
  quota_total: z.number().int(),
});
export type InvitesResponse = z.infer<typeof invitesResponse>;

export const invitePreview = z.object({
  valid: z.boolean(),
  reason: z.string().nullable(),
  inviter: z.string().nullable(),
  expires_at: z.number().nullable(),
});
export type InvitePreview = z.infer<typeof invitePreview>;

export const signupRequest = z.object({
  username: z.string().min(2).max(64),
  email: z.string().email().max(190),
  password: z.string().min(8).max(200),
  rules_accepted: z.literal(true),
  invite_code: z.string().max(32).optional(),
});
export type SignupRequest = z.infer<typeof signupRequest>;

export const requestItem = z.object({
  id: z.number().int(),
  user: z.object({ name: z.string(), hue: z.number().int() }),
  title: z.string(),
  description: z.string().nullable(),
  category: z.object({ slug: z.string(), name: z.string() }).nullable(),
  bounty: z.number(),
  status: z.string(),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
  fulfilled_by: z.string().nullable(),
});
export type RequestItem = z.infer<typeof requestItem>;

export const requestsResponse = z.object({ items: z.array(requestItem) });
export type RequestsResponse = z.infer<typeof requestsResponse>;

export const createRequestBody = z.object({
  title: z.string().min(4).max(190),
  description: z.string().max(2000).optional(),
  category_id: z.number().int().positive().optional(),
  bounty: z.number().int().min(0),
});
export type CreateRequestBody = z.infer<typeof createRequestBody>;

export const fulfillRequestBody = z.object({ username: z.string().min(1).max(64) });
export type FulfillRequestBody = z.infer<typeof fulfillRequestBody>;

export const requestActionResponse = z.object({
  ok: z.boolean(),
  status: z.string(),
  message: z.string(),
});
export type RequestActionResponse = z.infer<typeof requestActionResponse>;

export const topUser = z.object({
  rank: z.number().int(),
  username: z.string(),
  uploaded: z.number(),
  downloaded: z.number(),
  ratio: z.number().nullable(),
  bonus: z.number(),
  seedtime: z.number(),
});
export type TopUser = z.infer<typeof topUser>;

export const topTorrent = z.object({
  rank: z.number().int(),
  id: z.number().int(),
  name: z.string(),
  category: z.string(),
  seeders: z.number().int(),
  completed: z.number().int(),
  size: z.number(),
});
export type TopTorrent = z.infer<typeof topTorrent>;

export const topResponse = z.object({
  users: z.object({
    uploaded: z.array(topUser),
    bonus: z.array(topUser),
    seedtime: z.array(topUser),
  }),
  torrents: z.object({
    seeders: z.array(topTorrent),
    completed: z.array(topTorrent),
  }),
});
export type TopResponse = z.infer<typeof topResponse>;

export const userProfile = z.object({
  name: z.string(),
  role: role,
  class_key: z.string(),
  class: classBrief,
  joined_at: z.number(),
  uploaded: z.number(),
  downloaded: z.number(),
  raw_uploaded: z.number(),
  raw_downloaded: z.number(),
  ratio: z.number().nullable(),
  seedtime: z.number(),
  published_count: z.number().int(),
  seeding_count: z.number().int().nullable(),
  published_visible: z.boolean(),
  custom_title: z.string().nullable(),
  published: z.array(torrentSummary),
});
export type UserProfile = z.infer<typeof userProfile>;

/* ============================ 设置 / 2FA ============================ */

export const meSettingsResponse = z.object({
  username: z.string(),
  email: z.string(),
  passkey: z.string(),
  role,
  class_key: z.string(),
  class: classBrief,
  twofa_enabled: z.boolean(),
});
export type MeSettingsResponse = z.infer<typeof meSettingsResponse>;

export const updateMeSettingsBody = z.object({
  email: z.string().email().max(190).optional(),
  password: z.string().min(8).max(200).optional(),
  current_password: z.string().max(200).optional(),
});
export type UpdateMeSettingsBody = z.infer<typeof updateMeSettingsBody>;

export const twofaSetupResponse = z.object({
  secret: z.string(),
  otpauth_url: z.string(),
});
export type TwofaSetupResponse = z.infer<typeof twofaSetupResponse>;

export const twofaCodeBody = z.object({ code: z.string().min(6).max(6) });
export const twofaPasswordBody = z.object({ password: z.string().min(1) });
export const twofaEnableResponse = z.object({ recovery_codes: z.array(z.string()) });
export type TwofaEnableResponse = z.infer<typeof twofaEnableResponse>;

export const preferencesResponse = z.object({
  email_review: z.boolean(),
  email_hnr: z.boolean(),
  email_invite: z.boolean(),
  email_social: z.boolean(),
  email_weekly: z.boolean(),
  public_seeding: z.boolean(),
  public_published: z.boolean(),
  searchable: z.boolean(),
});
export type PreferencesResponse = z.infer<typeof preferencesResponse>;

export const updatePreferencesBody = preferencesResponse.partial();
export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBody>;

/* ============================ Staff ============================ */

export const staffSummaryResponse = z.object({
  pending_review: z.number().int(),
  open_reports: z.number().int(),
  anomalies: z.number().int(),
  users: z.number().int(),
  torrents: z.number().int(),
  schema_version: z.number().int(),
});
export type StaffSummaryResponse = z.infer<typeof staffSummaryResponse>;

export const staffUserItem = z.object({
  id: z.number().int(),
  username: z.string(),
  email: z.string(),
  role,
  class_key: z.string(),
  class: classBrief,
  warnings: z.number().int(),
  invite_balance: z.number().int(),
  custom_title: z.string().nullable(),
  status: userStatus,
  uploaded: z.number(),
  downloaded: z.number(),
  raw_uploaded: z.number(),
  raw_downloaded: z.number(),
  ratio: z.number().nullable(),
  bonus: z.number(),
  created_at: z.number(),
  last_seen_at: z.number().nullable(),
});
export type StaffUserItem = z.infer<typeof staffUserItem>;

export const staffUsersResponse = z.object({ items: z.array(staffUserItem) });
export type StaffUsersResponse = z.infer<typeof staffUsersResponse>;

export const staffActionBody = z.object({ reason: z.string().max(500).optional() });
export const staffActionResponse = z.object({
  ok: z.boolean(),
  status: z.string(),
  message: z.string(),
});
export type StaffActionResponse = z.infer<typeof staffActionResponse>;

export const reportItem = z.object({
  id: z.number().int(),
  reporter: z.string().nullable(),
  target_type: z.string(),
  target_id: z.string(),
  target_label: z.string(),
  reason: z.string(),
  detail: z.string().nullable(),
  status: z.string(),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
});
export type ReportItem = z.infer<typeof reportItem>;

export const reportsResponse = z.object({ items: z.array(reportItem) });
export type ReportsResponse = z.infer<typeof reportsResponse>;

export const resolveReportBody = z.object({
  action: z.enum(["resolve", "dismiss"]),
  reason: z.string().max(500).optional(),
});

export const anomalyItem = z.object({
  id: z.number().int(),
  user: z.object({ name: z.string(), hue: z.number().int() }),
  kind: z.string(),
  severity: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
});
export type AnomalyItem = z.infer<typeof anomalyItem>;

export const anomaliesResponse = z.object({ items: z.array(anomalyItem) });
export type AnomaliesResponse = z.infer<typeof anomaliesResponse>;

export const resolveAnomalyBody = z.object({
  action: z.enum(["resolve", "dismiss", "freeze", "ban"]),
  days: z.number().int().min(1).max(365).optional(),
  reason: z.string().max(500).optional(),
});

export const auditItem = z.object({
  id: z.number().int(),
  actor: z.string().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  detail: z.string().nullable(),
  ip: z.string().nullable(),
  created_at: z.number(),
});
export type AuditItem = z.infer<typeof auditItem>;

export const auditResponse = z.object({ items: z.array(auditItem) });
export type AuditResponse = z.infer<typeof auditResponse>;

export const createReportBody = z.object({
  target_type: z.enum(["torrent", "user"]),
  target_id: z.string().min(1).max(64),
  reason: z.string().min(2).max(64),
  detail: z.string().max(1000).optional(),
});

/* ============================ 申诉 ============================ */

export const appealMessage = z.object({
  author: z.string().nullable(),
  body: z.string(),
  created_at: z.number(),
});

export const appealItem = z.object({
  id: z.number().int(),
  user: z.object({ name: z.string() }),
  kind: z.string(),
  target_id: z.string().nullable(),
  reason: z.string(),
  status: z.string(),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
  resolution_note: z.string().nullable(),
  messages: z.array(appealMessage),
});
export type AppealItem = z.infer<typeof appealItem>;

export const appealsResponse = z.object({ items: z.array(appealItem) });
export type AppealsResponse = z.infer<typeof appealsResponse>;

export const createAppealBody = z.object({
  kind: z.enum(["bonus_freeze", "other"]),
  reason: z.string().min(10).max(2000),
});
export type CreateAppealBody = z.infer<typeof createAppealBody>;

export const publicAppealBody = z.object({
  username: z.string().min(1).max(64),
  email: z.string().email().max(190),
  password: z.string().min(1).max(200),
  reason: z.string().min(10).max(2000),
});
export type PublicAppealBody = z.infer<typeof publicAppealBody>;

export const appealMessageBody = z.object({ body: z.string().min(1).max(2000) });

export const appealResolveBody = z.object({
  action: z.enum(["accept", "reject"]),
  note: z.string().max(1000).optional(),
});

/* ============================ Staff 设置 / 分区 ============================ */

export const staffSettings = z.object({
  site: z.object({
    name: z.string().min(1).max(64),
    tagline: z.string().max(160),
    locale: z.string().min(2).max(16),
  }),
  registration: z.object({
    open: z.boolean(),
    invite_registration_enabled: z.boolean(),
    closed_message: z.string().max(500),
    closed_registration_mode: z.enum(["auto", "form", "message"]),
    invite_require_email: z.boolean(),
  }),
  tracker: z.object({
    announce_interval: z.number().int().min(60),
    min_interval: z.number().int().min(30),
    peer_ttl: z.number().int().min(60),
    max_peers: z.number().int().min(1),
    allow_ipv6: z.boolean(),
  }),
  economy: z.object({
    bonus_enabled: z.boolean(),
    exchange_enabled: z.boolean(),
    request_min_bounty: z.number().int().min(0),
    request_max_bounty: z.number().int().min(0),
  }),
  review: z.object({
    auto_approve_trusted: z.boolean(),
    trusted_min_approved: z.number().int().min(0),
    pending_alert_hours: z.number().int().min(1),
  }),
  classes: z.object({
    recalc_enabled: z.boolean(),
    recalc_cron: z.string().min(5).max(64),
    next_run_at: z.number().nullable().optional(),
  }),
  bonus: z.object({
    cron: z.string().min(5).max(64),
    formula: z.string().min(1).max(2000),
    next_run_at: z.number().nullable().optional(),
    default_formula: z.string().optional(),
  }),
  shop: z.object({
    rename_cooldown_days: z.number().int().min(0).max(3650),
    username_reserve_days: z.number().int().min(0).max(3650),
    rename_refund_ratio: z.number().min(0).max(1),
    gift_max_per_transaction: z.number().int().min(-1),
    gift_message_max_length: z.number().int().min(0).max(2000),
    hnr_credit_expire_days: z.number().int().min(-1).max(3650),
  }),
});
export type StaffSettings = z.infer<typeof staffSettings>;

export const staffSettingsResponse = z.object({ settings: staffSettings });
export type StaffSettingsResponse = z.infer<typeof staffSettingsResponse>;

export const updateStaffSettingsBody = z.object({
  site: staffSettings.shape.site.partial().optional(),
  registration: staffSettings.shape.registration.partial().optional(),
  tracker: staffSettings.shape.tracker.partial().optional(),
  economy: staffSettings.shape.economy.partial().optional(),
  review: staffSettings.shape.review.partial().optional(),
  classes: staffSettings.shape.classes.omit({ next_run_at: true }).partial().optional(),
  bonus: staffSettings.shape.bonus.omit({ next_run_at: true, default_formula: true }).partial().optional(),
  shop: staffSettings.shape.shop.partial().optional(),
});
export type UpdateStaffSettingsBody = z.infer<typeof updateStaffSettingsBody>;

export const staffCategoryItem = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  display_order: z.number().int(),
});

export const staffSectionItem = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  display_order: z.number().int(),
  review_mode: z.string(),
  charter: z.string(),
  categories: z.array(staffCategoryItem),
});
export type StaffSectionItem = z.infer<typeof staffSectionItem>;

export const staffSectionsResponse = z.object({ items: z.array(staffSectionItem) });
export type StaffSectionsResponse = z.infer<typeof staffSectionsResponse>;

export const updateSectionBody = z.object({
  name: z.string().min(1).max(64).optional(),
  display_order: z.number().int().min(0).optional(),
  review_mode: z.string().min(1).max(16).optional(),
  charter: z.string().max(2000).optional(),
});
export type UpdateSectionBody = z.infer<typeof updateSectionBody>;

export const updateCategoryBody = z.object({
  name: z.string().min(1).max(64).optional(),
  display_order: z.number().int().min(0).optional(),
});

export const createSectionBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "只能使用小写字母、数字与连字符"),
  name: z.string().min(1).max(64),
  review_mode: z.string().min(1).max(16).default("pre"),
  display_order: z.number().int().min(0).optional(),
  charter: z.string().max(2000).optional(),
});
export type CreateSectionBody = z.infer<typeof createSectionBody>;

export const createCategoryBody = z.object({
  section_slug: z.string().min(1).max(32),
  slug: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "只能使用小写字母、数字与连字符"),
  name: z.string().min(1).max(64),
  display_order: z.number().int().min(0).optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBody>;

/* ============================ 首次安装向导 ============================ */

export const setupStatus = z.object({
  requires_setup: z.boolean(),
  user_count: z.number().int(),
  schema_version: z.number().int(),
});
export type SetupStatus = z.infer<typeof setupStatus>;

export const setupRequest = z.object({
  site_name: z.string().min(1).max(64),
  site_tagline: z.string().max(160).optional(),
  locale: z.string().min(2).max(16).default("zh-CN"),
  admin_username: z.string().min(2).max(64),
  admin_email: z.string().email().max(190),
  admin_password: z.string().min(8).max(200),
  base_sections: z.boolean().default(true),
  registration_open: z.boolean().default(true),
});
export type SetupRequest = z.infer<typeof setupRequest>;

export const setupResponse = z.object({
  ok: z.literal(true),
  user: userSummary,
  csrf_token: z.string(),
});
export type SetupResponse = z.infer<typeof setupResponse>;

/* ============================ Staff 用户管理 ============================ */

export const staffCreateUserBody = z.object({
  username: z.string().min(2).max(64),
  email: z.string().email().max(190),
  password: z.string().min(8).max(200),
  class_slug: z.string().min(1).max(32).default("user"),
  /** @deprecated 兼容旧客户端；优先使用 class_slug。 */
  role: role.optional(),
  /** @deprecated 兼容旧客户端；优先使用 class_slug。 */
  class_key: z.string().min(1).max(32).optional(),
});
export type StaffCreateUserBody = z.infer<typeof staffCreateUserBody>;

export const staffUpdateUserBody = z.object({
  username: z.string().min(1).max(64).optional(),
  email: z.string().email().max(190).optional(),
  class_slug: z.string().min(1).max(32).optional(),
  status: userStatus.optional(),
  password: z.string().min(8).max(200).optional(),
  /** 计入上传量（不改变实际上传 raw_uploaded）。 */
  uploaded: z.number().int().min(0).optional(),
  /** 计入下载量（不改变实际下载 raw_downloaded）。 */
  downloaded: z.number().int().min(0).optional(),
  /** 魔力值余额。 */
  bonus: z.number().min(0).optional(),
  invite_balance: z.number().int().min(0).optional(),
  warnings: z.number().int().min(0).optional(),
  custom_title: z.string().max(64).nullable().optional(),
  /** @deprecated 兼容旧客户端；优先使用 class_slug。 */
  role: role.optional(),
  /** @deprecated 兼容旧客户端；优先使用 class_slug。 */
  class_key: z.string().min(1).max(32).optional(),
});
export type StaffUpdateUserBody = z.infer<typeof staffUpdateUserBody>;


/* ============================ 等级 / 权限节点 ============================ */

export const classCondition = z.object({
  metric: z.string().min(1).max(32),
  op: z.enum([">=", ">", "<=", "<", "==", "!="]),
  value: z.number(),
  unit: z.enum(["B", "KB", "MB", "GB", "TB"]).optional(),
});
export type ClassCondition = z.infer<typeof classCondition>;

export const classRule = z.object({
  logic: z.enum(["all", "any"]),
  conditions: z.array(classCondition).max(30),
});
export type ClassRule = z.infer<typeof classRule>;

export const classItem = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  rank: z.number().int(),
  badge: z.string().nullable(),
  color: z.string().nullable(),
  description: z.string(),
  permissions: z.array(z.string()),
  invite_quota: z.number().int(),
  auto_approve_quota: z.number().int(),
  promote_rule: classRule.nullable(),
  demote_rule: classRule.nullable(),
  promote_grace_days: z.number().int(),
  demote_grace_days: z.number().int(),
  lock_manual: z.boolean(),
  manual_grantable: z.boolean(),
  visible: z.boolean(),
  exempt_hr: z.boolean(),
  exempt_ratio_matrix: z.boolean(),
  member_count: z.number().int().optional(),
});
export type ClassItem = z.infer<typeof classItem>;

export const classesResponse = z.object({ items: z.array(classItem) });
export type ClassesResponse = z.infer<typeof classesResponse>;

export const createClassBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(32),
  name: z.string().min(1).max(64),
  rank: z.number().int().optional(),
  badge: z.string().max(32).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  description: z.string().max(500).default(""),
  permissions: z.array(z.string().max(64)).default([]),
  invite_quota: z.number().int().min(0).max(100).default(0),
  auto_approve_quota: z.number().int().min(0).max(100).default(0),
  promote_rule: classRule.nullable().default(null),
  demote_rule: classRule.nullable().default(null),
  promote_grace_days: z.number().int().min(0).max(365).default(0),
  demote_grace_days: z.number().int().min(0).max(365).default(0),
  lock_manual: z.boolean().default(false),
  manual_grantable: z.boolean().default(true),
  visible: z.boolean().default(true),
  exempt_hr: z.boolean().default(false),
  exempt_ratio_matrix: z.boolean().default(false),
});
export type CreateClassBody = z.infer<typeof createClassBody>;

export const updateClassBody = createClassBody.omit({ slug: true }).partial();
export type UpdateClassBody = z.infer<typeof updateClassBody>;

export const classOrderBody = z.object({ slugs: z.array(z.string()).min(1) });

export const ratioMatrixRow = z.object({ download_gb: z.number().min(0), min_ratio: z.number().min(0) });
export const classRulesSettings = z.object({
  matrix_enabled: z.boolean(),
  ratio_matrix: z.array(ratioMatrixRow).max(20),
  matrix_target_slug: z.string().min(1).max(32),
});
export type ClassRulesSettings = z.infer<typeof classRulesSettings>;

export const classNotificationTemplates = z.object({
  promote: z.string().max(500),
  demote: z.string().max(500),
  demote_warning: z.string().max(500),
});
export type ClassNotificationTemplates = z.infer<typeof classNotificationTemplates>;

export const classSimulationRequest = z.object({ user_id: z.number().int() });

export const classMetricsSnapshot = z.object({
  age_days: z.number(),
  uploaded: z.number(),
  downloaded: z.number(),
  raw_uploaded: z.number(),
  raw_downloaded: z.number(),
  ratio: z.number().nullable(),
  seedtime_hours: z.number(),
  bonus: z.number(),
  torrents_published: z.number().int(),
  invites_used: z.number().int(),
  warnings: z.number().int(),
  hnr_unfinished: z.number().int(),
  last_active_days: z.number(),
});
export type ClassMetricsSnapshot = z.infer<typeof classMetricsSnapshot>;

export const classSimulationResponse = z.object({
  user_id: z.number().int(),
  username: z.string(),
  current: classBrief,
  target: classBrief.nullable(),
  action: z.enum(["promote", "demote", "keep"]),
  path: z.array(classBrief),
  missing: z.array(z.string()),
  demote_reason: z.string().nullable(),
  blocked_reason: z.string().nullable(),
  locked_until: z.number().nullable(),
  demote_due_at: z.number().nullable(),
  metrics: classMetricsSnapshot,
});
export type ClassSimulationResponse = z.infer<typeof classSimulationResponse>;

export const classSimulationSearchResponse = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      username: z.string(),
      class: classBrief,
    }),
  ),
});
export type ClassSimulationSearchResponse = z.infer<typeof classSimulationSearchResponse>;

export const classHistoryItem = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  username: z.string().nullable(),
  from_class: z.string().nullable(),
  to_class: z.string(),
  source: z.string(),
  reason: z.string(),
  actor: z.string().nullable(),
  created_at: z.number(),
});
export type ClassHistoryItem = z.infer<typeof classHistoryItem>;

export const classHistoryResponse = z.object({
  items: z.array(classHistoryItem),
  next_cursor: z.number().int().nullable(),
});
export type ClassHistoryResponse = z.infer<typeof classHistoryResponse>;

export const classRecalcResponse = z.object({
  ok: z.boolean(),
  scanned: z.number().int(),
  promoted: z.number().int(),
  demoted: z.number().int(),
});
export type ClassRecalcResponse = z.infer<typeof classRecalcResponse>;

export const classRunItem = z.object({
  id: z.number().int(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
  scanned: z.number().int(),
  promoted: z.number().int(),
  demoted: z.number().int(),
  error: z.string().nullable(),
  triggered_by: z.string(),
});
export const classRunsResponse = z.object({ items: z.array(classRunItem) });
export type ClassRunsResponse = z.infer<typeof classRunsResponse>;

export const classGrantBody = z.object({
  class_slug: z.string().min(1).max(32),
  expires_at: z.number().int().optional(),
  lock: z.boolean().optional(),
});
export type ClassGrantBody = z.infer<typeof classGrantBody>;

export const userPermissionOverridesBody = z.object({
  extra: z.array(z.string().max(64)).max(100).default([]),
  denied: z.array(z.string().max(64)).max(100).default([]),
  expires_at: z.number().int().optional(),
});
export type UserPermissionOverridesBody = z.infer<typeof userPermissionOverridesBody>;

export const userPermissionOverridesResponse = z.object({
  extra: z.array(z.string()),
  denied: z.array(z.string()),
  expires_at: z.number().nullable(),
});
export type UserPermissionOverridesResponse = z.infer<typeof userPermissionOverridesResponse>;

export const schedulerConfig = z.object({
  recalc_enabled: z.boolean(),
  recalc_cron: z.string().min(5).max(64),
  next_run_at: z.number().nullable(),
});
export type SchedulerConfig = z.infer<typeof schedulerConfig>;
