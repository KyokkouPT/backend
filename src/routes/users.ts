import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, userProfile } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { classBriefOf, loadClassById } from "../lib/classes.js";
import { notFound } from "../lib/problem.js";
import { numberCount, ratioFor } from "../lib/serialize.js";
import { listTorrents } from "../lib/torrent-query.js";

export function userRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/users/:name`, async (request) => {
      const name = (request.params as { name: string }).name;
      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("username", "=", name)
        .executeTakeFirst();

      // 封禁/停用账号不提供公开主页。
      if (!user || user.status !== "active") throw notFound("user_not_found", "用户不存在");

      const preferences = await db
        .selectFrom("user_preferences")
        .selectAll()
        .where("user_id", "=", user.id)
        .executeTakeFirst();

      const publishedVisible = preferences ? Number(preferences.public_published) === 1 : true;
      const seedingVisible = preferences ? Number(preferences.public_seeding) === 1 : true;

      const publishedCount = await db
        .selectFrom("torrents")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("uploader_id", "=", user.id)
        .where("status", "=", "approved")
        .where("deleted_at", "is", null)
        .executeTakeFirst();

      const seedingCount = seedingVisible
        ? numberCount(
            await db
              .selectFrom("snatches")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where("user_id", "=", user.id)
              .where("status", "=", "seeding")
              .executeTakeFirst(),
          )
        : null;

      const published = publishedVisible
        ? (
            await listTorrents(
              db,
              {
                limit: 10,
                sort: "added_desc",
                fields: [],
                uploader: user.username,
              },
              request.auth ? Number(request.auth.user.id) : null,
            )
          ).items
        : [];

      const classRow =
        user.class_id === null ? null : await loadClassById(db, Number(user.class_id));

      return userProfile.parse({
        name: user.username,
        role: user.role,
        class_key: classRow?.slug ?? user.class_key,
        class: classBriefOf(classRow, user.class_key, user.class_key),
        joined_at: Number(user.created_at),
        uploaded: Number(user.uploaded),
        downloaded: Number(user.downloaded),
        ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
        seedtime: Number(user.seedtime),
        published_count: numberCount(publishedCount),
        seeding_count: seedingCount,
        published_visible: publishedVisible,
        published,
      });
    });
  };
}
