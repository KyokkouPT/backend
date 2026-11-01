import type { Migration } from "./types.js";

/** 012_scheduler_leases · 多实例 cron 租约与常用索引。 */
export const migration012: Migration = {
  version: 12,
  name: "scheduler_leases",
  async up({ db }) {
    await db.schema
      .createTable("job_leases")
      .ifNotExists()
      .addColumn("key", "varchar(64)", (col) => col.primaryKey())
      .addColumn("owner", "varchar(160)", (col) => col.notNull())
      .addColumn("expires_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("job_leases_expires_idx")
      .ifNotExists()
      .on("job_leases")
      .columns(["expires_at"])
      .execute();

    const indexes: { name: string; table: string; columns: string[] }[] = [
      { name: "users_status_class_idx", table: "users", columns: ["status", "class_id"] },
      { name: "snatches_user_status_idx", table: "snatches", columns: ["user_id", "status"] },
      { name: "snatches_torrent_status_idx", table: "snatches", columns: ["torrent_id", "status"] },
      { name: "torrents_status_deleted_created_idx", table: "torrents", columns: ["status", "deleted_at", "created_at"] },
      { name: "torrents_status_deleted_seeders_idx", table: "torrents", columns: ["status", "deleted_at", "seeders"] },
      { name: "torrents_status_deleted_size_idx", table: "torrents", columns: ["status", "deleted_at", "size"] },
      { name: "bonus_ledger_created_idx", table: "bonus_ledger", columns: ["created_at"] },
    ];

    for (const index of indexes) {
      try {
        await db.schema
          .createIndex(index.name)
          .ifNotExists()
          .on(index.table as never)
          .columns(index.columns)
          .execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate|already exists/i.test(message)) throw error;
      }
    }
  },
};
