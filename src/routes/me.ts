import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, meResponse } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { requireAuth } from "../auth/csrf.js";
import { numberCount, toUserSummary } from "../lib/serialize.js";

export function meRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/me`, async (request) => {
      const auth = requireAuth(request);
      const userId = Number(auth.user.id);

      const [published, seeding, leeching, snatchRows] = await Promise.all([
        db
          .selectFrom("torrents")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("uploader_id", "=", userId)
          .where("status", "=", "approved")
          .where("deleted_at", "is", null)
          .executeTakeFirst(),
        db
          .selectFrom("snatches")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("user_id", "=", userId)
          .where("status", "=", "seeding")
          .executeTakeFirst(),
        db
          .selectFrom("snatches")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("user_id", "=", userId)
          .where("status", "=", "leeching")
          .executeTakeFirst(),
        db
          .selectFrom("snatches as sn")
          .innerJoin("torrents as t", "t.id", "sn.torrent_id")
          .select([
            "sn.torrent_id as torrent_id",
            "t.name as name",
            "sn.uploaded as uploaded",
            "sn.downloaded as downloaded",
            "sn.seedtime as seedtime",
            "sn.last_announce_at as last_announce_at",
          ])
          .where("sn.user_id", "=", userId)
          .orderBy("sn.last_announce_at", "desc")
          .limit(20)
          .execute(),
      ]);

      return meResponse.parse({
        user: toUserSummary(auth.user),
        stats: {
          seeding: numberCount(seeding),
          leeching: numberCount(leeching),
          published: numberCount(published),
        },
        // H&R 义务表在 003 迁移后接入；此时如实返回空列表。
        hnr: [],
        snatches: snatchRows.map((row) => ({
          torrent_id: Number(row.torrent_id),
          name: row.name,
          uploaded: Number(row.uploaded),
          downloaded: Number(row.downloaded),
          seedtime: Number(row.seedtime),
          last_announce_at: row.last_announce_at === null ? null : Number(row.last_announce_at),
        })),
      });
    });
  };
}
