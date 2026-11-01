import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, meResponse } from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { requireAuth } from "../auth/csrf.js";
import { seedingStats, yieldPerHourBase } from "../lib/bonus.js";
import { numberCount, toUserSummary } from "../lib/serialize.js";

export function meRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;

    app.get(`${API_PREFIX}/me`, async (request) => {
      const auth = requireAuth(request);
      const userId = Number(auth.user.id);

      const [published, seeding, leeching, snatchRows, hnrRows, seedStats] = await Promise.all([
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
            "sn.status as status",
          ])
          .where("sn.user_id", "=", userId)
          .orderBy("sn.last_announce_at", "desc")
          .limit(50)
          .execute(),
        db
          .selectFrom("hnr_obligations as h")
          .innerJoin("torrents as t", "t.id", "h.torrent_id")
          .select([
            "h.id as id",
            "h.torrent_id as torrent_id",
            "t.name as name",
            "h.deadline_at as deadline_at",
            "h.required_seconds as required_seconds",
            "h.seeded_seconds as seeded_seconds",
            "h.status as status",
          ])
          .where("h.user_id", "=", userId)
          .orderBy("h.deadline_at", "asc")
          .limit(20)
          .execute(),
        seedingStats(db, userId),
      ]);

      const frozenUntil =
        auth.user.bonus_frozen_until === null ? null : Number(auth.user.bonus_frozen_until);
      const frozen = frozenUntil !== null && frozenUntil > Date.now();

      return meResponse.parse({
        user: toUserSummary(auth.user, auth.class),
        stats: {
          seeding: numberCount(seeding),
          leeching: numberCount(leeching),
          published: numberCount(published),
        },
        hnr: hnrRows.map((row) => ({
          id: Number(row.id),
          torrent_id: Number(row.torrent_id),
          name: row.name,
          deadline_at: Number(row.deadline_at),
          required_seconds: Number(row.required_seconds),
          seeded_seconds: Number(row.seeded_seconds),
          status: row.status,
        })),
        snatches: snatchRows.map((row) => ({
          torrent_id: Number(row.torrent_id),
          name: row.name,
          uploaded: Number(row.uploaded),
          downloaded: Number(row.downloaded),
          seedtime: Number(row.seedtime),
          last_announce_at: row.last_announce_at === null ? null : Number(row.last_announce_at),
          status: row.status,
        })),
        rss_url: `${config.baseUrl}/rss?passkey=${auth.user.passkey}`,
        bonus_yield_per_hour: frozen
          ? 0
          : yieldPerHourBase(seedStats.count, seedStats.totalBytes),
        bonus_frozen_until: frozenUntil,
      });
    });
  };
}
