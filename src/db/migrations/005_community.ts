import type { Migration } from "./types.js";

/** 005_community · 邀请、求种、通知/隐私偏好。 */
export const migration005: Migration = {
  version: 5,
  name: "community",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : "bigint";

    await db.schema
      .createTable("invites")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("code", "varchar(32)", (col) => col.notNull().unique())
      .addColumn("inviter_id", "bigint", (col) => col.notNull())
      .addColumn("invited_user_id", "bigint")
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("unused"))
      .addColumn("note", "text")
      .addColumn("expires_at", "bigint", (col) => col.notNull())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("used_at", "bigint")
      .execute();

    await db.schema
      .createIndex("invites_inviter_created_idx")
      .ifNotExists()
      .on("invites")
      .columns(["inviter_id", "created_at"])
      .execute();

    await db.schema
      .createTable("requests")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("title", "varchar(190)", (col) => col.notNull())
      .addColumn("description", "text")
      .addColumn("category_id", "bigint")
      .addColumn("bounty_bonus", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("open"))
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("resolved_at", "bigint")
      .addColumn("fulfilled_by", "bigint")
      .execute();

    await db.schema
      .createIndex("requests_status_created_idx")
      .ifNotExists()
      .on("requests")
      .columns(["status", "created_at"])
      .execute();

    await db.schema
      .createTable("user_preferences")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("user_id", "bigint", (col) => col.notNull().unique())
      .addColumn("email_review", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("email_hnr", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("email_invite", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("email_social", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("email_weekly", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("public_seeding", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("public_published", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("searchable", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();
  },
};
