import type { Generated } from "kysely";
import type { Role, UserStatus } from "@kyokkou/contracts";

/**
 * Kysely 的 Database 类型（迁移 001 范围）。
 *
 * 约定：
 * - 计数与毫秒时间戳用 bigint 列，应用层统一为 number（写入 < 2^53），
 *   驱动层在 db.ts 里把 int8 解析成 number；
 * - 布尔用 integer 0/1（SQLite 没有原生 boolean，避免跨驱动返回类型不一致）；
 * - JSON 用 text 存序列化字符串；
 * - 主键是 Generated<number>，迁移按方言生成 integer/bigint autoincrement。
 */

export interface InstanceMetaTable {
  id: Generated<number>;
  instance_id: string;
  schema_version: number;
  install_state: string;
  installed_at: number;
}

export interface SchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: number;
}

export interface SiteSettingsTable {
  key: string;
  value_json: string;
  updated_at: number;
}

export interface AuditLogsTable {
  id: Generated<number>;
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail_json: string | null;
  ip: string | null;
  created_at: number;
}

export interface UsernameReservationsTable {
  id: Generated<number>;
  username: string;
  user_id: number;
  reserved_until: number;
  released_at: number | null;
  created_at: number;
}

export interface UsernameChangesTable {
  id: Generated<number>;
  user_id: number;
  old_username: string;
  new_username: string;
  price: number;
  refund_amount: number;
  item_id: number | null;
  actor_id: number | null;
  created_at: number;
}

export interface JobLeasesTable {
  key: string;
  owner: string;
  expires_at: number;
  updated_at: number;
}

export interface PeersTable {
  id: Generated<number>;
  torrent_id: number;
  user_id: number;
  peer_id_hex: string;
  ip: string;
  port: number;
  left_bytes: number;
  seeder: number;
  last_seen: number;
  created_at: number;
}

export interface UsersTable {
  id: Generated<number>;
  username: string;
  email: string;
  password_hash: string;
  passkey: string;
  role: Role;
  class_key: string;
  status: UserStatus;
  uploaded: number;
  downloaded: number;
  /** Tracker 实际上报流量（不打折、不受魔力兑换影响）。 */
  raw_uploaded: number;
  raw_downloaded: number;
  bonus: number;
  seedtime: number;
  invited_by: number | null;
  created_at: number;
  last_seen_at: number | null;
  bonus_frozen_until: number | null;
  last_bonus_at: number | null;
  username_changed_at: number | null;
  twofa_secret: string | null;
  twofa_enabled: number | null;
  /** 等级；迁移 008 回填，应用层保证有值。 */
  class_id: number | null;
  warnings: number;
  invite_balance: number;
  class_locked_until: number | null;
  custom_title: string | null;
  demote_due_at: number | null;
}

export interface ClassesTable {
  id: Generated<number>;
  slug: string;
  name: string;
  rank: number;
  badge: string | null;
  color: string | null;
  description: string;
  permissions_json: string;
  invite_quota: number;
  auto_approve_quota: number;
  promote_rule_json: string | null;
  demote_rule_json: string | null;
  demote_target_slug: string | null;
  promote_grace_days: number;
  demote_grace_days: number;
  lock_manual: number;
  manual_grantable: number;
  visible: number;
  exempt_hr: number;
  exempt_ratio_matrix: number;
  created_at: number;
  updated_at: number;
}

export interface UserPermissionOverridesTable {
  id: Generated<number>;
  user_id: number;
  permission: string;
  effect: "grant" | "deny";
  expires_at: number | null;
  actor_id: number | null;
  created_at: number;
}

export interface UserClassHistoryTable {
  id: Generated<number>;
  user_id: number;
  from_class_id: number | null;
  to_class_id: number;
  source: "auto" | "manual" | "system";
  reason: string;
  detail_json: string | null;
  actor_id: number | null;
  created_at: number;
}

export interface ClassRecalcRunsTable {
  id: Generated<number>;
  started_at: number;
  finished_at: number | null;
  scanned: number;
  promoted: number;
  demoted: number;
  error: string | null;
  triggered_by: "cron" | "manual";
  actor_id: number | null;
}

export interface UserClassProgressTable {
  id: Generated<number>;
  user_id: number;
  target_class_id: number;
  first_met_at: number;
  last_checked_at: number;
}

export interface SessionsTable {
  id: Generated<number>;
  user_id: number;
  token_hash: string;
  csrf_hash: string;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface SectionsTable {
  id: Generated<number>;
  slug: string;
  name: string;
  display_order: number;
  review_mode: string;
  config_json: string;
}

export interface CategoriesTable {
  id: Generated<number>;
  section_id: number;
  slug: string;
  name: string;
  display_order: number;
}

export interface TorrentsTable {
  id: Generated<number>;
  info_hash: string;
  name: string;
  section_id: number;
  category_id: number;
  uploader_id: number;
  size: number;
  files_count: number;
  status: string;
  promo: string;
  seeders: number;
  leechers: number;
  completed: number;
  /** 独立于促销的零魔标记：做种魔力权重 0.2。 */
  zero_bonus: number;
  description: string | null;
  meta_json: string | null;
  /** 原始 .torrent 字节；下载时只替换 announce，保留 info 原始字节。 */
  torrent_blob: Buffer | null;
  created_at: number;
  approved_at: number | null;
  deleted_at: number | null;
}

export interface TorrentFilesTable {
  id: Generated<number>;
  torrent_id: number;
  path: string;
  size: number;
}

export interface TorrentFieldValuesTable {
  id: Generated<number>;
  torrent_id: number;
  field_key: string;
  value_text: string;
}

export interface TagsTable {
  id: Generated<number>;
  slug: string;
  name: string;
}

export interface TorrentTagsTable {
  torrent_id: number;
  tag_id: number;
}

export interface PromoEventsTable {
  id: Generated<number>;
  name: string;
  scope: string;
  promo: string;
  starts_at: number | null;
  ends_at: number | null;
}

export interface AnnouncementsTable {
  id: Generated<number>;
  title: string;
  body: string;
  author_id: number | null;
  pinned: number;
  tone: string;
  created_at: number;
}

export interface SnatchesTable {
  id: Generated<number>;
  user_id: number;
  torrent_id: number;
  uploaded: number;
  downloaded: number;
  seedtime: number;
  last_announce_at: number | null;
  status: string;
  completed_at: number | null;
}

export interface HnrPoliciesTable {
  id: Generated<number>;
  section_id: number | null;
  enabled: number;
  include_rate: number;
  min_download: number;
  seed_seconds: number;
  deadline_days: number;
  exempt_json: string | null;
  created_at: number;
}

export interface HnrObligationsTable {
  id: Generated<number>;
  user_id: number;
  torrent_id: number;
  policy_id: number | null;
  required_seconds: number;
  seeded_seconds: number;
  deadline_at: number;
  status: string;
  resolved_at: number | null;
  created_at: number;
}

export interface BonusLedgerTable {
  id: Generated<number>;
  user_id: number;
  kind: string;
  delta: number;
  balance_after: number;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  created_at: number;
}

export interface ExchangeItemsTable {
  id: Generated<number>;
  key: string;
  name: string;
  description: string | null;
  price: number;
  inventory: number | null;
  limit_per_user: number | null;
  enabled: number;
  payload_json: string;
  display_order: number;
  direction: string;
  type: string | null;
  amount: number | null;
  params_json: string | null;
  min_class_rank: number | null;
}

export interface RedemptionsTable {
  id: Generated<number>;
  user_id: number;
  item_id: number;
  price: number;
  status: string;
  idempotency_key: string | null;
  created_at: number;
  type: string | null;
  params_json: string | null;
  actor_id: number | null;
  item_key: string | null;
}

export interface UserCreditsTable {
  id: Generated<number>;
  user_id: number;
  kind: string;
  quantity: number;
  expires_at: number | null;
  source_redemption_id: number | null;
  created_at: number;
}

export interface InvitesTable {
  id: Generated<number>;
  code: string;
  inviter_id: number;
  invited_user_id: number | null;
  status: string;
  note: string | null;
  expires_at: number;
  created_at: number;
  used_at: number | null;
  email: string | null;
}

export interface RequestsTable {
  id: Generated<number>;
  user_id: number;
  title: string;
  description: string | null;
  category_id: number | null;
  bounty_bonus: number;
  status: string;
  created_at: number;
  resolved_at: number | null;
  fulfilled_by: number | null;
}

export interface UserPreferencesTable {
  id: Generated<number>;
  user_id: number;
  email_review: number;
  email_hnr: number;
  email_invite: number;
  email_social: number;
  email_weekly: number;
  public_seeding: number;
  public_published: number;
  searchable: number;
  updated_at: number;
}

export interface NotificationsTable {
  id: Generated<number>;
  user_id: number;
  kind: string;
  title: string;
  body: string;
  link_url: string | null;
  read_at: number | null;
  created_at: number;
}

export interface TwofaRecoveryCodesTable {
  id: Generated<number>;
  user_id: number;
  code_hash: string;
  used_at: number | null;
  created_at: number;
}

export interface ReportsTable {
  id: Generated<number>;
  reporter_id: number;
  target_type: string;
  target_id: string;
  target_label: string;
  reason: string;
  detail: string | null;
  status: string;
  resolved_by: number | null;
  resolved_at: number | null;
  created_at: number;
}

export interface AnomaliesTable {
  id: Generated<number>;
  user_id: number;
  kind: string;
  severity: string;
  status: string;
  detail_json: string | null;
  resolved_by: number | null;
  resolved_at: number | null;
  created_at: number;
}

export interface AppealsTable {
  id: Generated<number>;
  user_id: number;
  kind: string;
  target_id: string | null;
  reason: string;
  status: string;
  resolved_by: number | null;
  resolved_at: number | null;
  resolution_note: string | null;
  created_at: number;
}

export interface AppealMessagesTable {
  id: Generated<number>;
  appeal_id: number;
  author_id: number;
  body: string;
  created_at: number;
}

export interface Database {
  instance_meta: InstanceMetaTable;
  schema_migrations: SchemaMigrationsTable;
  site_settings: SiteSettingsTable;
  audit_logs: AuditLogsTable;
  users: UsersTable;
  sessions: SessionsTable;
  sections: SectionsTable;
  categories: CategoriesTable;
  torrents: TorrentsTable;
  torrent_files: TorrentFilesTable;
  torrent_field_values: TorrentFieldValuesTable;
  tags: TagsTable;
  torrent_tags: TorrentTagsTable;
  promo_events: PromoEventsTable;
  announcements: AnnouncementsTable;
  snatches: SnatchesTable;
  notifications: NotificationsTable;
  hnr_policies: HnrPoliciesTable;
  hnr_obligations: HnrObligationsTable;
  bonus_ledger: BonusLedgerTable;
  exchange_items: ExchangeItemsTable;
  redemptions: RedemptionsTable;
  invites: InvitesTable;
  requests: RequestsTable;
  user_preferences: UserPreferencesTable;
  twofa_recovery_codes: TwofaRecoveryCodesTable;
  reports: ReportsTable;
  anomalies: AnomaliesTable;
  appeals: AppealsTable;
  appeal_messages: AppealMessagesTable;
  classes: ClassesTable;
  user_permission_overrides: UserPermissionOverridesTable;
  user_class_history: UserClassHistoryTable;
  class_recalc_runs: ClassRecalcRunsTable;
  user_class_progress: UserClassProgressTable;
  job_leases: JobLeasesTable;
  peers: PeersTable;
  username_reservations: UsernameReservationsTable;
  username_changes: UsernameChangesTable;
  user_credits: UserCreditsTable;
}
