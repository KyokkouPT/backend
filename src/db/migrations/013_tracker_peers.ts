import type { Migration } from "./types.js";

/** 013_tracker_peers · DB 化 peer 状态，支持多实例 announce/scrape。 */
export const migration013: Migration = {
  version: 13,
  name: "tracker_peers",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : "bigint";

    await db.schema
      .createTable("peers")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("peer_id_hex", "varchar(40)", (col) => col.notNull())
      .addColumn("ip", "varchar(64)", (col) => col.notNull())
      .addColumn("port", "integer", (col) => col.notNull())
      .addColumn("left_bytes", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("seeder", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("last_seen", "bigint", (col) => col.notNull())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("peers_torrent_seeder_seen_idx")
      .ifNotExists()
      .on("peers")
      .columns(["torrent_id", "seeder", "last_seen"])
      .execute();

    await db.schema
      .createIndex("peers_last_seen_idx")
      .ifNotExists()
      .on("peers")
      .columns(["last_seen"])
      .execute();

    await db.schema
      .createIndex("peers_torrent_user_peer_uq")
      .ifNotExists()
      .unique()
      .on("peers")
      .columns(["torrent_id", "user_id", "peer_id_hex"])
      .execute();
  },
};
