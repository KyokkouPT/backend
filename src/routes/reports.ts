import type { FastifyPluginAsync } from "fastify";
import { API_PREFIX, createReportBody } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";
import { normalizeUsername } from "../lib/username.js";

export function reportRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.post(`${API_PREFIX}/reports`, async (request, reply) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(createReportBody, request.body ?? {});

      let label = "";
      if (body.target_type === "torrent") {
        const torrent = await db
          .selectFrom("torrents")
          .select("name")
          .where("id", "=", Number(body.target_id))
          .executeTakeFirst();
        if (!torrent) throw notFound("target_not_found", "举报对象不存在");
        label = torrent.name;
      } else {
        const target = await db
          .selectFrom("users")
          .select("username")
          .where("username", "=", normalizeUsername(body.target_id))
          .executeTakeFirst();
        if (!target) throw notFound("target_not_found", "举报对象不存在");
        label = target.username;
      }

      await db
        .insertInto("reports")
        .values({
          reporter_id: Number(auth.user.id),
          target_type: body.target_type,
          target_id: body.target_id,
          target_label: label.slice(0, 190),
          reason: body.reason,
          detail: body.detail ?? null,
          status: "open",
          resolved_by: null,
          resolved_at: null,
          created_at: Date.now(),
        })
        .execute();

      return reply.status(201).send({ ok: true });
    });
  };
}
