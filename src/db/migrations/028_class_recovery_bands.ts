import type { Migration } from "./types.js";

const GB = 1024 ** 3;

/** 028_class_recovery_bands · 受限用户按下载量分段恢复。 */
export const migration028: Migration = {
  version: 28,
  name: "class_recovery_bands",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";
    await db.schema
      .createTable("class_recovery_bands")
      .addColumn("id", idType, (col) =>
        dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement(),
      )
      .addColumn("min_download_bytes", "bigint", (col) => col.notNull())
      .addColumn("max_download_bytes", "bigint")
      .addColumn("min_ratio", "double precision", (col) => col.notNull())
      .addColumn("display_order", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    const now = Date.now();
    await db
      .insertInto("class_recovery_bands")
      .values([
        {
          min_download_bytes: 50 * GB,
          max_download_bytes: 100 * GB,
          min_ratio: 0.4,
          display_order: 10,
          created_at: now,
          updated_at: now,
        },
        {
          min_download_bytes: 100 * GB,
          max_download_bytes: 200 * GB,
          min_ratio: 0.5,
          display_order: 20,
          created_at: now,
          updated_at: now,
        },
        {
          min_download_bytes: 200 * GB,
          max_download_bytes: 400 * GB,
          min_ratio: 0.6,
          display_order: 30,
          created_at: now,
          updated_at: now,
        },
        {
          min_download_bytes: 400 * GB,
          max_download_bytes: 800 * GB,
          min_ratio: 0.7,
          display_order: 40,
          created_at: now,
          updated_at: now,
        },
        {
          min_download_bytes: 800 * GB,
          max_download_bytes: null,
          min_ratio: 0.8,
          display_order: 50,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
  },
};
