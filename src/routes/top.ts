import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, topResponse, type TopTorrent, type TopUser } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { ratioFor } from "../lib/serialize.js";

export function topRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/top`, async () => {
      const userRows = await db
        .selectFrom("users")
        .selectAll()
        .where("status", "=", "active")
        .execute();

      const buildUsers = (compare: (a: (typeof userRows)[number], b: (typeof userRows)[number]) => number) =>
        [...userRows]
          .sort(compare)
          .slice(0, 10)
          .map((user, index): TopUser => ({
            rank: index + 1,
            username: user.username,
            uploaded: Number(user.uploaded),
            downloaded: Number(user.downloaded),
            ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
            bonus: Number(user.bonus),
            seedtime: Number(user.seedtime),
          }));

      const torrentRows = await db
        .selectFrom("torrents as t")
        .innerJoin("categories as c", "c.id", "t.category_id")
        .select([
          "t.id as id",
          "t.name as name",
          "t.seeders as seeders",
          "t.completed as completed",
          "t.size as size",
          "c.name as category_name",
        ])
        .where("t.status", "=", "approved")
        .where("t.deleted_at", "is", null)
        .execute();

      const buildTorrents = (
        compare: (a: (typeof torrentRows)[number], b: (typeof torrentRows)[number]) => number,
      ) =>
        [...torrentRows]
          .sort(compare)
          .slice(0, 10)
          .map((torrent, index): TopTorrent => ({
            rank: index + 1,
            id: Number(torrent.id),
            name: torrent.name,
            category: torrent.category_name,
            seeders: Number(torrent.seeders),
            completed: Number(torrent.completed),
            size: Number(torrent.size),
          }));

      return topResponse.parse({
        users: {
          uploaded: buildUsers((a, b) => Number(b.uploaded) - Number(a.uploaded)),
          bonus: buildUsers((a, b) => Number(b.bonus) - Number(a.bonus)),
          seedtime: buildUsers((a, b) => Number(b.seedtime) - Number(a.seedtime)),
        },
        torrents: {
          seeders: buildTorrents((a, b) => Number(b.seeders) - Number(a.seeders)),
          completed: buildTorrents((a, b) => Number(b.completed) - Number(a.completed)),
        },
      });
    });
  };
}
