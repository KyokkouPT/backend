import type { Migration } from "./types.js";

/** 007_moderation · 举报、反作弊、申诉与申诉消息。 */
export const migration007: Migration = {
  version: 7,
  name: "moderation",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("reports")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("reporter_id", "bigint", (col) => col.notNull())
      .addColumn("target_type", "varchar(16)", (col) => col.notNull())
      .addColumn("target_id", "varchar(64)", (col) => col.notNull())
      .addColumn("target_label", "varchar(190)", (col) => col.notNull())
      .addColumn("reason", "varchar(64)", (col) => col.notNull())
      .addColumn("detail", "text")
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("open"))
      .addColumn("resolved_by", "bigint")
      .addColumn("resolved_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("reports_status_created_idx")
      .on("reports")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createTable("anomalies")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("kind", "varchar(32)", (col) => col.notNull())
      .addColumn("severity", "varchar(16)", (col) => col.notNull().defaultTo("low"))
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("open"))
      .addColumn("detail_json", "text")
      .addColumn("resolved_by", "bigint")
      .addColumn("resolved_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("anomalies_status_created_idx")
      .on("anomalies")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createTable("appeals")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("kind", "varchar(16)", (col) => col.notNull())
      .addColumn("target_id", "varchar(64)")
      .addColumn("reason", "text", (col) => col.notNull())
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("open"))
      .addColumn("resolved_by", "bigint")
      .addColumn("resolved_at", "bigint")
      .addColumn("resolution_note", "text")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("appeals_status_created_idx")
      .on("appeals")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createTable("appeal_messages")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("appeal_id", "bigint", (col) => col.notNull())
      .addColumn("author_id", "bigint", (col) => col.notNull())
      .addColumn("body", "text", (col) => col.notNull())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("appeal_messages_appeal_idx")
      .on("appeal_messages")
      .columns(["appeal_id", "created_at"])
      .execute();
  },
};
