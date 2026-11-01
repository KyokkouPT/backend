import type { Migration } from "./types.js";

/** 006_twofa · TOTP secret/开关与一次性恢复码。 */
export const migration006: Migration = {
  version: 6,
  name: "twofa",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema.alterTable("users").addColumn("twofa_secret", "varchar(64)").execute();
    await db.schema.alterTable("users").addColumn("twofa_enabled", "integer").execute();

    await db.schema
      .createTable("twofa_recovery_codes")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("code_hash", "varchar(64)", (col) => col.notNull())
      .addColumn("used_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("twofa_recovery_user_idx")
      .on("twofa_recovery_codes")
      .columns(["user_id"])
      .execute();
  },
};
