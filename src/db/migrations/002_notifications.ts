import type { Migration } from "./types.js";

/**
 * 002_notifications · 审核动作需要通知发布者（CAT-10）。
 * 社区纵切的通知页/偏好复用这张表；invites 等后续再排版本。
 */
export const migration002: Migration = {
  version: 2,
  name: "notifications",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("notifications")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("kind", "varchar(32)", (col) => col.notNull())
      .addColumn("title", "varchar(190)", (col) => col.notNull())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("link_url", "varchar(255)")
      .addColumn("read_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("notifications_user_read_created_idx")
      .on("notifications")
      .columns(["user_id", "read_at", "created_at"])
      .execute();
  },
};
