import type { Migration } from "./types.js";

/**
 * 001_init · 基础表。
 *
 * 跨库约定：
 * - SQLite 主键 `integer primary key autoincrement`，MySQL `bigint auto_increment`，
 *   PostgreSQL `bigserial`（Kysely 按方言处理 autoIncrement + 类型）；
 * - 不建外键，靠唯一约束与索引保证关系；
 * - 布尔用 integer 0/1；
 * - MySQL 的 DDL 非事务：建表用 ifNotExists；索引重复会明确失败，
 *   不会静默留下半套 schema。
 */
export const migration001: Migration = {
  version: 1,
  name: "init",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";
    const blobType = dialect === "postgres" ? "bytea" : "blob";

    await db.schema
      .createTable("instance_meta")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("instance_id", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("schema_version", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("install_state", "varchar(32)", (col) => col.notNull().defaultTo("installed"))
      .addColumn("installed_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("site_settings")
      .ifNotExists()
      .addColumn("key", "varchar(64)", (col) => col.primaryKey())
      .addColumn("value_json", "text", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("audit_logs")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("actor_id", "bigint")
      .addColumn("action", "varchar(64)", (col) => col.notNull())
      .addColumn("target_type", "varchar(32)")
      .addColumn("target_id", "varchar(64)")
      .addColumn("detail_json", "text")
      .addColumn("ip", "varchar(64)")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("audit_logs_created_idx")
      .on("audit_logs")
      .columns(["created_at"])
      .execute();

    await db.schema
      .createTable("users")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("username", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("email", "varchar(190)", (col) => col.notNull().unique())
      .addColumn("password_hash", "text", (col) => col.notNull())
      .addColumn("passkey", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("role", "varchar(16)", (col) => col.notNull().defaultTo("user"))
      .addColumn("class_key", "varchar(32)", (col) => col.notNull().defaultTo("user"))
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("active"))
      .addColumn("uploaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("downloaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("bonus", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("seedtime", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("invited_by", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("last_seen_at", "bigint")
      .execute();

    await db.schema
      .createIndex("users_status_idx")
      .on("users")
      .columns(["status"])
      .execute();

    await db.schema
      .createTable("sessions")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("token_hash", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("csrf_hash", "varchar(64)", (col) => col.notNull())
      .addColumn("expires_at", "bigint", (col) => col.notNull())
      .addColumn("ip", "varchar(64)")
      .addColumn("user_agent", "varchar(255)")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("sessions_user_idx")
      .on("sessions")
      .columns(["user_id"])
      .execute();

    await db.schema
      .createIndex("sessions_expires_idx")
      .on("sessions")
      .columns(["expires_at"])
      .execute();

    await db.schema
      .createTable("sections")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("slug", "varchar(32)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(64)", (col) => col.notNull())
      .addColumn("display_order", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("review_mode", "varchar(16)", (col) => col.notNull().defaultTo("pre"))
      .addColumn("config_json", "text", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("categories")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("section_id", "bigint", (col) => col.notNull())
      .addColumn("slug", "varchar(64)", (col) => col.notNull())
      .addColumn("name", "varchar(64)", (col) => col.notNull())
      .addColumn("display_order", "integer", (col) => col.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createIndex("categories_section_slug_uq")
      .on("categories")
      .columns(["section_id", "slug"])
      .unique()
      .execute();

    await db.schema
      .createTable("torrents")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("info_hash", "varchar(40)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(255)", (col) => col.notNull())
      .addColumn("section_id", "bigint", (col) => col.notNull())
      .addColumn("category_id", "bigint", (col) => col.notNull())
      .addColumn("uploader_id", "bigint", (col) => col.notNull())
      .addColumn("size", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("files_count", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("pending"))
      .addColumn("promo", "varchar(8)", (col) => col.notNull().defaultTo("none"))
      .addColumn("seeders", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("leechers", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("completed", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("description", "text")
      .addColumn("meta_json", "text")
      .addColumn("torrent_blob", blobType)
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("approved_at", "bigint")
      .addColumn("deleted_at", "bigint")
      .execute();

    await db.schema
      .createIndex("torrents_status_created_idx")
      .on("torrents")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createIndex("torrents_section_idx")
      .on("torrents")
      .columns(["section_id"])
      .execute();

    await db.schema
      .createIndex("torrents_category_idx")
      .on("torrents")
      .columns(["category_id"])
      .execute();

    await db.schema
      .createIndex("torrents_uploader_idx")
      .on("torrents")
      .columns(["uploader_id"])
      .execute();

    await db.schema
      .createTable("torrent_files")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("path", "text", (col) => col.notNull())
      .addColumn("size", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("torrent_files_torrent_idx")
      .on("torrent_files")
      .columns(["torrent_id"])
      .execute();

    await db.schema
      .createTable("torrent_field_values")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("field_key", "varchar(32)", (col) => col.notNull())
      .addColumn("value_text", "varchar(255)", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("torrent_fields_torrent_key_uq")
      .on("torrent_field_values")
      .columns(["torrent_id", "field_key"])
      .unique()
      .execute();

    await db.schema
      .createIndex("torrent_fields_key_value_idx")
      .on("torrent_field_values")
      .columns(["field_key", "value_text"])
      .execute();

    await db.schema
      .createTable("tags")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("slug", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(64)", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("torrent_tags")
      .ifNotExists()
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("tag_id", "bigint", (col) => col.notNull())
      .addPrimaryKeyConstraint("torrent_tags_pk", ["torrent_id", "tag_id"])
      .execute();

    await db.schema
      .createTable("promo_events")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("name", "varchar(128)", (col) => col.notNull())
      .addColumn("scope", "varchar(128)", (col) => col.notNull())
      .addColumn("promo", "varchar(8)", (col) => col.notNull())
      .addColumn("starts_at", "bigint")
      .addColumn("ends_at", "bigint")
      .execute();

    await db.schema
      .createTable("announcements")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("title", "varchar(190)", (col) => col.notNull())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("author_id", "bigint")
      .addColumn("pinned", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("tone", "varchar(8)", (col) => col.notNull().defaultTo("info"))
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("announcements_created_idx")
      .on("announcements")
      .columns(["created_at"])
      .execute();

    await db.schema
      .createTable("snatches")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("uploaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("downloaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("seedtime", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("last_announce_at", "bigint")
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("leeching"))
      .execute();

    await db.schema
      .createIndex("snatches_user_torrent_uq")
      .on("snatches")
      .columns(["user_id", "torrent_id"])
      .unique()
      .execute();
  },
};
