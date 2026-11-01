import type { Selectable } from "kysely";
import type { Db } from "../db/db.js";
import { evaluateHnr } from "../lib/hnr.js";
import type { TorrentsTable, UsersTable } from "../db/types.js";

type UserRow = Selectable<UsersTable>;
type TorrentRow = Selectable<TorrentsTable>;

const MAX_SEEDTIME_DELTA_MS = 6 * 3_600_000;

/**
 * 把一次 announce 写进 snatches/users/torrents，并评估 H&R。
 *
 * 关键不变量：
 * - users/snatches 的流量是生命周期累计；
 * - 每个 peer 会话单独记录上一轮 counters，同一会话重复 announce 不会重复计数；
 * - 新 peer 会话（重新下载/重新做种）从 0 开始，会计入新的流量；
 * - event=completed 只计一次（snatches.completed_at + torrents.completed）；
 * - promo 影响站点统计：free 不计下载、2x 上传双倍、50/30 打折。
 */
export async function recordAnnounce(
  db: Db,
  input: {
    user: UserRow;
    torrent: TorrentRow;
    peerIdHex: string;
    uploaded: number;
    downloaded: number;
    left: number;
    event: string;
    promo: string;
  },
): Promise<void> {
  const now = Date.now();

  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("snatches")
      .selectAll()
      .where("user_id", "=", input.user.id)
      .where("torrent_id", "=", input.torrent.id)
      .executeTakeFirst();

    const session = await trx
      .selectFrom("tracker_sessions")
      .selectAll()
      .where("user_id", "=", input.user.id)
      .where("torrent_id", "=", input.torrent.id)
      .where("peer_id_hex", "=", input.peerIdHex)
      .executeTakeFirst();

    let uploadDelta: number;
    let downloadDelta: number;
    if (session) {
      const sessionUploaded = Number(session.uploaded);
      const sessionDownloaded = Number(session.downloaded);
      // 客户端计数器正常只增；变小说明客户端重开/重新添加了任务，从当前值重新开始。
      uploadDelta =
        input.uploaded >= sessionUploaded ? input.uploaded - sessionUploaded : input.uploaded;
      downloadDelta =
        input.downloaded >= sessionDownloaded
          ? input.downloaded - sessionDownloaded
          : input.downloaded;
    } else {
      uploadDelta = input.uploaded;
      downloadDelta = input.downloaded;
    }

    if (session) {
      await trx
        .updateTable("tracker_sessions")
        .set({
          uploaded: input.uploaded,
          downloaded: input.downloaded,
          last_seen: now,
        })
        .where("id", "=", session.id)
        .execute();
    } else {
      await trx
        .insertInto("tracker_sessions")
        .values({
          user_id: Number(input.user.id),
          torrent_id: Number(input.torrent.id),
          peer_id_hex: input.peerIdHex,
          uploaded: input.uploaded,
          downloaded: input.downloaded,
          last_seen: now,
          created_at: now,
        })
        .execute();
    }

    const previousUploaded = existing ? Number(existing.uploaded) : 0;
    const previousDownloaded = existing ? Number(existing.downloaded) : 0;
    const nextUploaded = previousUploaded + uploadDelta;
    const nextDownloaded = previousDownloaded + downloadDelta;

    const seedtimeDelta =
      existing && input.left === 0 && existing.last_announce_at !== null
        ? Math.floor(
            Math.min(Math.max(0, now - Number(existing.last_announce_at)), MAX_SEEDTIME_DELTA_MS) / 1000,
          )
        : 0;

    const alreadyCompleted = existing?.completed_at !== null && existing?.completed_at !== undefined;
    const completedNow = input.event === "completed" && !alreadyCompleted;
    const status = input.left > 0 ? "leeching" : "seeding";

    if (existing) {
      await trx
        .updateTable("snatches")
        .set({
          uploaded: nextUploaded,
          downloaded: nextDownloaded,
          seedtime: Number(existing.seedtime) + seedtimeDelta,
          last_announce_at: now,
          status,
          ...(completedNow ? { completed_at: now } : {}),
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await trx
        .insertInto("snatches")
        .values({
          user_id: Number(input.user.id),
          torrent_id: Number(input.torrent.id),
          uploaded: nextUploaded,
          downloaded: nextDownloaded,
          seedtime: 0,
          last_announce_at: now,
          status,
          completed_at: completedNow ? now : null,
        })
        .execute();
    }

    const uploadFactor = input.promo === "2x" ? 2 : 1;
    const downloadFactor =
      input.promo === "free" ? 0 : input.promo === "50" ? 0.5 : input.promo === "30" ? 0.3 : 1;

    if (uploadDelta > 0 || downloadDelta > 0) {
      const currentUser = await trx
        .selectFrom("users")
        .select(["uploaded", "downloaded", "raw_uploaded", "raw_downloaded"])
        .where("id", "=", input.user.id)
        .executeTakeFirstOrThrow();

      await trx
        .updateTable("users")
        .set({
          // 实际量：Tracker 上报原始增量，不打折、不受兑换影响。
          raw_uploaded: Number(currentUser.raw_uploaded) + uploadDelta,
          raw_downloaded: Number(currentUser.raw_downloaded) + downloadDelta,
          // 计入量：促销系数；兑换在 economy 里单独增减。
          uploaded: Number(currentUser.uploaded) + Math.floor(uploadDelta * uploadFactor),
          downloaded: Number(currentUser.downloaded) + Math.floor(downloadDelta * downloadFactor),
        })
        .where("id", "=", input.user.id)
        .execute();
    }

    if (completedNow) {
      await trx
        .updateTable("torrents")
        .set({ completed: Number(input.torrent.completed) + 1 })
        .where("id", "=", input.torrent.id)
        .execute();
    }

    await evaluateHnr(trx, {
      userId: Number(input.user.id),
      torrentId: Number(input.torrent.id),
      sectionId: Number(input.torrent.section_id),
      downloaded: nextDownloaded,
      seededSecondsDelta: seedtimeDelta,
      isSeeding: input.left === 0,
    });
  });
}
