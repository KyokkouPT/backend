import type { Migration } from "./types.js";

/** 020_tracker_sessions · 按客户端 peer 会话记录累计流量，允许重复下载/做种重新计数。 */
export const migration020: Migration = {
  version: 20,
  name: "tracker_sessions",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("tracker_sessions")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("torrent_id", "bigint", (col) => col.notNull())
      .addColumn("peer_id_hex", "varchar(40)", (col) => col.notNull())
      .addColumn("uploaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("downloaded", "bigint", (col) => col.notNull().defaultTo(0))
      .addColumn("last_seen", "bigint", (col) => col.notNull())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("tracker_sessions_user_torrent_peer_uq")
      .unique()
      .on("tracker_sessions")
      .columns(["user_id", "torrent_id", "peer_id_hex"])
      .execute();

    await db.schema
      .createIndex("tracker_sessions_last_seen_idx")
      .on("tracker_sessions")
      .columns(["last_seen"])
      .execute();

    // 把当前已存在的 Peer 用现有 snatch 累计值初始化，避免部署后第一次
    // 周期性 announce 把历史流量重复计一遍。新的 Peer/新会话从 0 开始。
    const existing = await db.selectFrom("tracker_sessions").select("id").limit(1).executeTakeFirst();
    if (existing) return;

    const [peers, snatches] = await Promise.all([
      db
        .selectFrom("peers")
        .select(["user_id", "torrent_id", "peer_id_hex", "last_seen", "created_at"])
        .execute(),
      db
        .selectFrom("snatches")
        .select(["user_id", "torrent_id", "uploaded", "downloaded"])
        .execute(),
    ]);
    const snatchByTorrent = new Map(
      snatches.map((row) => [`${String(row.user_id)}:${String(row.torrent_id)}`, row]),
    );

    for (const row of peers) {
      const snatch = snatchByTorrent.get(`${String(row.user_id)}:${String(row.torrent_id)}`);
      await db
        .insertInto("tracker_sessions")
        .values({
          user_id: Number(row.user_id),
          torrent_id: Number(row.torrent_id),
          peer_id_hex: row.peer_id_hex,
          uploaded: Number(snatch?.uploaded ?? 0),
          downloaded: Number(snatch?.downloaded ?? 0),
          last_seen: Number(row.last_seen),
          created_at: Number(row.created_at),
        })
        .execute();
    }
  },
};
