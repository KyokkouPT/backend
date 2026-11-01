import type { Db } from "../db/db.js";
import type { TrackerPeer } from "./registry.js";

export type PeerUpsert = {
  torrentId: number;
  userId: number;
  peerIdHex: string;
  ip: string;
  port: number;
  left: number;
  seeder: boolean;
  lastSeen: number;
};

function toPeer(row: {
  peer_id_hex: string;
  ip: string;
  port: number;
  user_id: number;
  last_seen: number;
  left_bytes: number;
  seeder: number;
}): TrackerPeer {
  return {
    peerIdHex: row.peer_id_hex,
    ip: row.ip,
    port: Number(row.port),
    userId: Number(row.user_id),
    lastSeen: Number(row.last_seen),
    left: Number(row.left_bytes),
    seeder: Number(row.seeder) === 1,
  };
}

export async function upsertPeer(db: Db, input: PeerUpsert): Promise<void> {
  const existing = await db
    .selectFrom("peers")
    .select("id")
    .where("torrent_id", "=", input.torrentId)
    .where("user_id", "=", input.userId)
    .where("peer_id_hex", "=", input.peerIdHex)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable("peers")
      .set({
        ip: input.ip,
        port: input.port,
        left_bytes: input.left,
        seeder: input.seeder ? 1 : 0,
        last_seen: input.lastSeen,
      })
      .where("id", "=", existing.id)
      .execute();
    return;
  }
  try {
    await db
      .insertInto("peers")
      .values({
        torrent_id: input.torrentId,
        user_id: input.userId,
        peer_id_hex: input.peerIdHex,
        ip: input.ip,
        port: input.port,
        left_bytes: input.left,
        seeder: input.seeder ? 1 : 0,
        last_seen: input.lastSeen,
        created_at: input.lastSeen,
      })
      .execute();
  } catch (error) {
    // 并发 announce 的竞争：唯一键冲突后退化为更新。
    const message = error instanceof Error ? error.message : String(error);
    if (!/unique|duplicate/i.test(message)) throw error;
    await db
      .updateTable("peers")
      .set({
        ip: input.ip,
        port: input.port,
        left_bytes: input.left,
        seeder: input.seeder ? 1 : 0,
        last_seen: input.lastSeen,
      })
      .where("torrent_id", "=", input.torrentId)
      .where("user_id", "=", input.userId)
      .where("peer_id_hex", "=", input.peerIdHex)
      .execute();
  }
}

export async function removePeer(
  db: Db,
  torrentId: number,
  userId: number,
  peerIdHex: string,
): Promise<void> {
  await db
    .deleteFrom("peers")
    .where("torrent_id", "=", torrentId)
    .where("user_id", "=", userId)
    .where("peer_id_hex", "=", peerIdHex)
    .execute();
}

export async function countPeers(
  db: Db,
  torrentId: number,
): Promise<{ seeders: number; leechers: number }> {
  const rows = await db
    .selectFrom("peers")
    .select("seeder")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("torrent_id", "=", torrentId)
    .groupBy("seeder")
    .execute();
  let seeders = 0;
  let leechers = 0;
  for (const row of rows) {
    if (Number(row.seeder) === 1) seeders = Number(row.count);
    else leechers = Number(row.count);
  }
  return { seeders, leechers };
}

export async function syncTorrentCounts(db: Db, torrentId: number): Promise<void> {
  const counts = await countPeers(db, torrentId);
  await db
    .updateTable("torrents")
    .set({ seeders: counts.seeders, leechers: counts.leechers })
    .where("id", "=", torrentId)
    .execute();
}

export async function listPeers(
  db: Db,
  torrentId: number,
  options: { limit: number; excludeUserId?: number; excludePeerIdHex?: string },
): Promise<TrackerPeer[]> {
  const rows = await db
    .selectFrom("peers")
    .select(["peer_id_hex", "ip", "port", "user_id", "last_seen", "left_bytes", "seeder"])
    .where("torrent_id", "=", torrentId)
    .orderBy("last_seen", "desc")
    .limit(options.limit + 1)
    .execute();
  return rows
    .map(toPeer)
    .filter(
      (peer) =>
        !(
          options.excludeUserId !== undefined &&
          options.excludePeerIdHex !== undefined &&
          peer.userId === options.excludeUserId &&
          peer.peerIdHex === options.excludePeerIdHex
        ),
    )
    .slice(0, options.limit);
}

export async function prunePeers(db: Db, ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  const affected = await db
    .selectFrom("peers")
    .select("torrent_id")
    .distinct()
    .where("last_seen", "<", cutoff)
    .execute();
  const deleted = await db.deleteFrom("peers").where("last_seen", "<", cutoff).executeTakeFirst();
  await db.deleteFrom("tracker_sessions").where("last_seen", "<", cutoff).execute();
  for (const row of affected) {
    await syncTorrentCounts(db, Number(row.torrent_id));
  }
  return Number(deleted.numDeletedRows ?? 0);
}

export async function clearPeersForTests(db: Db): Promise<void> {
  await db.deleteFrom("peers").execute();
  await db.deleteFrom("tracker_sessions").execute();
}
