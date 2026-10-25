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
  bonus: number;
  seedtime: number;
  invited_by: number | null;
  created_at: number;
  last_seen_at: number | null;
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
}
