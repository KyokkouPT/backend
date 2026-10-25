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

export const userSummary = z.object({
  id: z.number().int(),
  username: z.string(),
  role: role,
  class_key: z.string(),
  status: userStatus,
  uploaded: z.number(),
  downloaded: z.number(),
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

export const exchangeItem = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  inventory: z.number().nullable(),
  limit_per_user: z.number().nullable(),
  enabled: z.boolean(),
  payload_type: z.string(),
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

export const exchangeResponse = z.object({
  ok: z.boolean(),
  balance: z.number(),
  item_key: z.string(),
  message: z.string(),
});
export type ExchangeResponse = z.infer<typeof exchangeResponse>;

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
});
export type InviteItem = z.infer<typeof inviteItem>;

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
  joined_at: z.number(),
  uploaded: z.number(),
  downloaded: z.number(),
  ratio: z.number().nullable(),
  seedtime: z.number(),
  published_count: z.number().int(),
  seeding_count: z.number().int().nullable(),
  published_visible: z.boolean(),
  published: z.array(torrentSummary),
});
export type UserProfile = z.infer<typeof userProfile>;
