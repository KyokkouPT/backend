import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, notificationsResponse } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { unreadNotificationCount } from "../lib/notifications.js";

export function notificationRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/notifications`, async (request) => {
      const auth = requireAuth(request);
      const userId = Number(auth.user.id);

      const [rows, unread] = await Promise.all([
        db
          .selectFrom("notifications")
          .selectAll()
          .where("user_id", "=", userId)
          .orderBy("created_at", "desc")
          .limit(50)
          .execute(),
        unreadNotificationCount(db, userId),
      ]);

      return notificationsResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          kind: row.kind,
          title: row.title,
          body: row.body,
          link_url: row.link_url,
          read_at: row.read_at === null ? null : Number(row.read_at),
          created_at: Number(row.created_at),
        })),
        unread,
      });
    });

    app.post(`${API_PREFIX}/notifications/:id/read`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      const id = Number((request.params as { id: string }).id);
      if (Number.isInteger(id) && id > 0) {
        await db
          .updateTable("notifications")
          .set({ read_at: Date.now() })
          .where("id", "=", id)
          .where("user_id", "=", Number(auth.user.id))
          .where("read_at", "is", null)
          .execute();
      }

      return { ok: true };
    });

    app.post(`${API_PREFIX}/notifications/read-all`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      await db
        .updateTable("notifications")
        .set({ read_at: Date.now() })
        .where("user_id", "=", Number(auth.user.id))
        .where("read_at", "is", null)
        .execute();

      return { ok: true };
    });
  };
}
