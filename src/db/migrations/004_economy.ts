import type { Migration } from "./types.js";

/**
 * 004_economy · H&R 策略/义务、魔力账本、兑换项、兑换记录，
 * 以及用户收益冻结与上次结算时间。
 */
export const migration004: Migration = {
  version: 4,
  name: "economy",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("hnr_policies")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("section_id", "bigint")
      .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("include_rate", "integer", (col) => col.notNull().defaultTo(100))
      .addColumn("min_download", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("seed_seconds", "integer", (col) => col.notNull().defaultTo(259200))
      .addColumn("deadline_days", "integer", (col) => col.notNull().defaultTo(14))
      .addColumn("exempt_json", "text")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("hnr_obligations")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("policy_id", "bigint")
      .addColumn("required_seconds", "integer", (col) => col.notNull())
      .addColumn("seeded_seconds", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("deadline_at", "bigint", (col) => col.notNull())
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("inspecting"))
      .addColumn("resolved_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("hnr_obligations_user_torrent_uq")
      .on("hnr_obligations")
      .columns(["user_id", "torrent_id"])
      .unique()
      .execute();

    await db.schema
      .createIndex("hnr_obligations_status_deadline_idx")
      .on("hnr_obligations")
      .columns(["status", "deadline_at"])
      .execute();

    await db.schema
      .createTable("bonus_ledger")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("kind", "varchar(32)", (col) => col.notNull())
      .addColumn("delta", "bigint", (col) => col.notNull())
      .addColumn("balance_after", "bigint", (col) => col.notNull())
      .addColumn("ref_type", "varchar(32)")
      .addColumn("ref_id", "varchar(64)")
      .addColumn("note", "text")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("bonus_ledger_user_created_idx")
      .on("bonus_ledger")
      .columns(["user_id", "created_at"])
      .execute();

    await db.schema
      .createTable("exchange_items")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("key", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(128)", (col) => col.notNull())
      .addColumn("description", "text")
      .addColumn("price", "bigint", (col) => col.notNull())
      .addColumn("inventory", "bigint")
      .addColumn("limit_per_user", "integer")
      .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("payload_json", "text", (col) => col.notNull())
      .addColumn("display_order", "integer", (col) => col.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createTable("redemptions")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("item_id", "bigint", (col) => col.notNull())
      .addColumn("price", "bigint", (col) => col.notNull())
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("completed"))
      .addColumn("idempotency_key", "varchar(64)")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("redemptions_idempotency_uq")
      .on("redemptions")
      .columns(["idempotency_key"])
      .unique()
      .execute();

    await db.schema
      .createIndex("redemptions_user_created_idx")
      .on("redemptions")
      .columns(["user_id", "created_at"])
      .execute();

    await db.schema.alterTable("users").addColumn("bonus_frozen_until", "bigint").execute();
    await db.schema.alterTable("users").addColumn("last_bonus_at", "bigint").execute();
  },
};
