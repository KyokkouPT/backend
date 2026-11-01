/** 默认等级预设与角色迁移映射；迁移、seed 与测试共用。 */

export type ClassCondition = {
  metric: string;
  op: string;
  value: number;
  unit?: string;
};

export type ClassRule = {
  logic: "all" | "any";
  conditions: ClassCondition[];
};

export type DefaultClass = {
  slug: string;
  name: string;
  rank: number;
  badge: string | null;
  color: string | null;
  description: string;
  permissions: string[];
  inviteQuota: number;
  autoApproveQuota: number;
  promoteRule: ClassRule | null;
  demoteRule: ClassRule | null;
  promoteGraceDays: number;
  demoteGraceDays: number;
  lockManual: boolean;
  manualGrantable: boolean;
  visible: boolean;
  exemptHr: boolean;
  exemptRatioMatrix: boolean;
};

/** 所有登录用户的基础能力；保证升级前后现有功能不丢失。 */
export const BASE_PERMISSIONS = [
  "torrent.upload",
  "torrent.download",
  "request.create",
  "request.fulfill",
  "subtitle.upload",
  "comment.post",
  "user.view_profile",
  "user.search",
  "ranking.view",
  "log.view",
  "invite.create",
  "bonus.exchange",
  "rss.read",
  "class.auto_promote",
  "class.auto_demote",
] as const;

export const STAFF_PERMISSIONS = [
  "staff.available",
  "staff.access",
  "staff.review",
  "staff.reports",
  "staff.users",
  "staff.user_class",
  "staff.anomalies",
  "staff.audit",
  "staff.settings",
  "staff.appeals",
  "staff.classes",
  "staff.announcement",
  "staff.user_edit",
  "staff.user_warn",
  "staff.user_status",
  "staff.invite_view",
  "staff.ip_view",
] as const;

export const USER_EXTRA_PERMISSIONS = [
  "user.list",
  "user.view_history",
  "user.view_comments",
  "poll.create",
  "log.view_sensitive",
] as const;

export const OWNER_PERMISSIONS = [
  ...BASE_PERMISSIONS,
  ...STAFF_PERMISSIONS,
  ...USER_EXTRA_PERMISSIONS,
  "torrent.auto_approve",
  "torrent.anonymous",
  "torrent.view_hidden",
  "torrent.edit",
  "torrent.delete",
  "torrent.pin",
  "torrent.promote",
  "comment.moderate",
  "user.view_anonymous",
] as const;

const gb = 1024 ** 3;

function rule(logic: "all" | "any", conditions: ClassCondition[]): ClassRule {
  return { logic, conditions };
}

function autoLevel(
  slug: string,
  name: string,
  rank: number,
  description: string,
  thresholds: { days: number; gb: number; ratio: number; demoteRatio: number },
  extraPermissions: string[],
  inviteQuota: number,
  autoApproveQuota: number,
): DefaultClass {
  return {
    slug,
    name,
    rank,
    badge: null,
    color: null,
    description,
    permissions: [...BASE_PERMISSIONS, ...extraPermissions],
    inviteQuota,
    autoApproveQuota,
    promoteRule: rule("all", [
      { metric: "age_days", op: ">=", value: thresholds.days },
      { metric: "downloaded", op: ">=", value: thresholds.gb, unit: "GB" },
      { metric: "ratio", op: ">", value: thresholds.ratio },
    ]),
    demoteRule: rule("any", [
      { metric: "ratio", op: "<", value: thresholds.demoteRatio },
    ]),
    promoteGraceDays: 0,
    demoteGraceDays: 7,
    lockManual: false,
    manualGrantable: true,
    visible: true,
    exemptHr: false,
    exemptRatioMatrix: false,
  };
}

export const DEFAULT_CLASSES: DefaultClass[] = [
  {
    slug: "leechwarn",
    name: "受限",
    rank: 0,
    badge: "!",
    color: "danger",
    description: "分享率过低或违规被限制；恢复后自动解除。",
    permissions: ["torrent.download"],
    inviteQuota: 0,
    autoApproveQuota: 0,
    promoteRule: null,
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: false,
    manualGrantable: false,
    visible: true,
    exemptHr: false,
    exemptRatioMatrix: true,
  },
  {
    slug: "user",
    name: "新用户",
    rank: 10,
    badge: null,
    color: null,
    description: "注册后的默认等级。",
    permissions: [...BASE_PERMISSIONS],
    inviteQuota: 0,
    autoApproveQuota: 0,
    promoteRule: { logic: "all", conditions: [] },
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: false,
    manualGrantable: true,
    visible: true,
    exemptHr: false,
    exemptRatioMatrix: false,
  },
  autoLevel(
    "member",
    "成员",
    20,
    "注册满 4 周、下载 50GB、分享率 1.05。",
    { days: 28, gb: 50, ratio: 1.05, demoteRatio: 0.95 },
    [],
    1,
    0,
  ),
  autoLevel(
    "advanced",
    "进阶",
    30,
    "注册满 8 周、下载 120GB、分享率 1.55。",
    { days: 56, gb: 120, ratio: 1.55, demoteRatio: 1.45 },
    ["user.list", "user.view_history", "torrent.auto_approve", "torrent.anonymous"],
    2,
    1,
  ),
  autoLevel(
    "elite",
    "精英",
    40,
    "注册满 15 周、下载 300GB、分享率 2.05。",
    { days: 105, gb: 300, ratio: 2.05, demoteRatio: 1.95 },
    ["user.list", "user.view_history", "user.view_comments", "poll.create", "torrent.auto_approve", "torrent.anonymous"],
    2,
    1,
  ),
  autoLevel(
    "master",
    "大师",
    50,
    "注册满 25 周、下载 500GB、分享率 2.55。",
    { days: 175, gb: 500, ratio: 2.55, demoteRatio: 2.45 },
    ["user.list", "user.view_history", "user.view_comments", "poll.create", "torrent.auto_approve", "torrent.anonymous"],
    3,
    2,
  ),
  autoLevel(
    "legend",
    "传奇",
    60,
    "注册满 40 周、下载 750GB、分享率 3.05。",
    { days: 280, gb: 750, ratio: 3.05, demoteRatio: 2.95 },
    ["user.list", "user.view_history", "user.view_comments", "poll.create", "torrent.auto_approve", "torrent.anonymous", "log.view_sensitive"],
    5,
    3,
  ),
  {
    slug: "honor",
    name: "荣誉",
    rank: 70,
    badge: "★",
    color: "accent",
    description: "授予有贡献的成员、发布员或压制组（手动）。",
    permissions: [...BASE_PERMISSIONS, ...USER_EXTRA_PERMISSIONS, "torrent.anonymous"],
    inviteQuota: 1,
    autoApproveQuota: 0,
    promoteRule: null,
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: true,
    manualGrantable: true,
    visible: true,
    exemptHr: true,
    exemptRatioMatrix: true,
  },
  {
    slug: "uploader",
    name: "发布组",
    rank: 75,
    badge: "↑",
    color: "accent",
    description: "专注发布（手动）；免 H&R、免分享率矩阵。",
    permissions: [
      ...BASE_PERMISSIONS,
      ...USER_EXTRA_PERMISSIONS,
      "torrent.auto_approve",
      "torrent.anonymous",
      "torrent.view_hidden",
    ],
    inviteQuota: 1,
    autoApproveQuota: 0,
    promoteRule: null,
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: true,
    manualGrantable: true,
    visible: true,
    exemptHr: true,
    exemptRatioMatrix: true,
  },
  {
    slug: "staff",
    name: "管理组",
    rank: 80,
    badge: "◆",
    color: "accent",
    description: "拥有管理权限（手动授予）。",
    permissions: [
      ...BASE_PERMISSIONS,
      ...STAFF_PERMISSIONS,
      ...USER_EXTRA_PERMISSIONS,
      "torrent.auto_approve",
      "torrent.anonymous",
      "torrent.view_hidden",
      "torrent.edit",
      "torrent.delete",
      "torrent.pin",
      "torrent.promote",
      "comment.moderate",
      "user.view_anonymous",
    ],
    inviteQuota: 0,
    autoApproveQuota: 0,
    promoteRule: null,
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: true,
    manualGrantable: true,
    visible: false,
    exemptHr: true,
    exemptRatioMatrix: true,
  },
  {
    slug: "owner",
    name: "最高等级",
    rank: 90,
    badge: "∞",
    color: "accent",
    description: "站点最高等级，拥有全部权限（手动）。",
    permissions: [...OWNER_PERMISSIONS],
    inviteQuota: 5,
    autoApproveQuota: 0,
    promoteRule: null,
    demoteRule: null,
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: true,
    manualGrantable: false,
    visible: false,
    exemptHr: true,
    exemptRatioMatrix: true,
  },
];

export const DEFAULT_CLASS_SLUG = "user";

export const ROLE_CLASS_MAP: Record<string, string> = {
  admin: "owner",
  moderator: "staff",
  user: DEFAULT_CLASS_SLUG,
};
