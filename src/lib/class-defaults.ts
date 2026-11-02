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

export const USER_EDIT_BASIC_PERMISSIONS = [
  "staff.user_edit.password",
  "staff.user_edit.email",
  "staff.user_edit.bonus",
  "staff.user_edit.uploaded",
  "staff.user_edit.downloaded",
  "staff.user_edit.invite_balance",
  "staff.user_edit.warnings",
] as const;

export const USER_EDIT_SENSITIVE_PERMISSIONS = [
  "staff.user_edit.username",
  "staff.user_edit.class",
  "staff.user_edit.status",
  "staff.user_edit.custom_title",
] as const;

export const STAFF_PERMISSIONS = [
  "staff.available",
  "staff.access",
  "staff.review",
  "staff.reports",
  "staff.users",
  "staff.anomalies",
  "staff.audit",
  "staff.settings",
  "staff.appeals",
  "staff.classes",
  "staff.announcement",
  "staff.user_warn",
  "staff.invite_view",
  "staff.ip_view",
  "staff.class_simulate",
  "staff.class_history",
  ...USER_EDIT_BASIC_PERMISSIONS,
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
  ...USER_EDIT_SENSITIVE_PERMISSIONS,
  ...USER_EXTRA_PERMISSIONS,
  "staff.bonus_shop",
  "staff.operations",
  "torrent.auto_approve",
  "torrent.anonymous",
  "user.donor",
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
  thresholds: {
    days: number;
    gb: number;
    ratio: number;
    demoteRatio: number;
    seedPoints: number;
  },
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
      { metric: "ratio", op: ">=", value: thresholds.ratio },
      { metric: "seed_points", op: ">=", value: thresholds.seedPoints },
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
    exemptRatioMatrix: true,
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
    promoteRule: null,
    demoteRule: rule("all", [
      { metric: "downloaded", op: ">", value: 50, unit: "GB" },
      { metric: "ratio", op: "<", value: 0.4 },
    ]),
    promoteGraceDays: 0,
    demoteGraceDays: 0,
    lockManual: false,
    manualGrantable: true,
    visible: true,
    exemptHr: false,
    exemptRatioMatrix: true,
  },
  autoLevel(
    "member",
    "成员",
    20,
    "注册满 4 周、下载 50GB、分享率 1.05、做种积分 40000。",
    { days: 28, gb: 50, ratio: 1.05, demoteRatio: 0.95, seedPoints: 40000 },
    [],
    1,
    0,
  ),
  autoLevel(
    "advanced",
    "进阶",
    30,
    "注册满 8 周、下载 120GB、分享率 1.55、做种积分 80000。",
    { days: 56, gb: 120, ratio: 1.55, demoteRatio: 1.45, seedPoints: 80000 },
    [],
    2,
    0,
  ),
  autoLevel(
    "elite",
    "精英",
    40,
    "注册满 15 周、下载 300GB、分享率 2.05、做种积分 150000。",
    { days: 105, gb: 300, ratio: 2.05, demoteRatio: 1.95, seedPoints: 150000 },
    [],
    2,
    0,
  ),
  autoLevel(
    "master",
    "大师",
    50,
    "注册满 25 周、下载 500GB、分享率 2.55、做种积分 250000。",
    { days: 175, gb: 500, ratio: 2.55, demoteRatio: 2.45, seedPoints: 250000 },
    [],
    3,
    0,
  ),
  autoLevel(
    "legend",
    "传奇",
    60,
    "注册满 40 周、下载 750GB、分享率 3.05、做种积分 400000。",
    { days: 280, gb: 750, ratio: 3.05, demoteRatio: 2.95, seedPoints: 400000 },
    [],
    5,
    0,
  ),
  autoLevel(
    "glory",
    "荣耀",
    70,
    "注册满 60 周、下载 1024GB、分享率 3.55、做种积分 600000。",
    { days: 420, gb: 1024, ratio: 3.55, demoteRatio: 3.45, seedPoints: 600000 },
    [],
    0,
    0,
  ),
  autoLevel(
    "supreme",
    "至尊",
    80,
    "注册满 80 周、下载 1536GB、分享率 4.05、做种积分 800000。",
    { days: 560, gb: 1536, ratio: 4.05, demoteRatio: 3.95, seedPoints: 800000 },
    [],
    5,
    0,
  ),
  autoLevel(
    "hall",
    "殿堂",
    90,
    "注册满 100 周、下载 3072GB、分享率 4.55、做种积分 1000000。",
    { days: 700, gb: 3072, ratio: 4.55, demoteRatio: 4.45, seedPoints: 1000000 },
    [],
    10,
    0,
  ),
  {
    slug: "vip",
    name: "VIP",
    rank: 100,
    badge: "V",
    color: "accent",
    description: "VIP 用户（手动）。",
    permissions: [
      ...BASE_PERMISSIONS,
      ...USER_EXTRA_PERMISSIONS,
      "torrent.auto_approve",
      "torrent.anonymous",
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
    slug: "retiree",
    name: "退休用户",
    rank: 110,
    badge: null,
    color: null,
    description: "退休用户（手动）。",
    permissions: [...BASE_PERMISSIONS],
    inviteQuota: 0,
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
    rank: 120,
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
    rank: 130,
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
    slug: "administrator",
    name: "管理员",
    rank: 140,
    badge: "◆",
    color: "accent",
    description: "管理员（手动）。",
    permissions: [...OWNER_PERMISSIONS],
    inviteQuota: 0,
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
  {
    slug: "sysop",
    name: "系统管理员",
    rank: 150,
    badge: "◆",
    color: "accent",
    description: "系统管理员（手动）。",
    permissions: [...OWNER_PERMISSIONS],
    inviteQuota: 0,
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
  {
    slug: "owner",
    name: "最高等级",
    rank: 160,
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
