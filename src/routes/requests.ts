import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  createRequestBody,
  fulfillRequestBody,
  requestActionResponse,
  requestsResponse,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { permissionsFor } from "../auth/permissions.js";
import { createNotification } from "../lib/notifications.js";
import { HttpProblem, badRequest, conflict, forbidden, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";
import { hueFor } from "../lib/serialize.js";
import { loadSettings } from "../lib/settings.js";

function requireStaff(request: Parameters<typeof requireAuth>[0]): ReturnType<typeof requireAuth> {
  const auth = requireAuth(request);
  if (!permissionsFor(auth.user.role).includes("staff.review")) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

export function requestRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/requests`, async (request) => {
      const query = request.query as { status?: string };
      let builder = db
        .selectFrom("requests as r")
        .leftJoin("users as u", "u.id", "r.user_id")
        .leftJoin("categories as c", "c.id", "r.category_id")
        .leftJoin("users as f", "f.id", "r.fulfilled_by")
        .select([
          "r.id as id",
          "r.title as title",
          "r.description as description",
          "r.bounty_bonus as bounty_bonus",
          "r.status as status",
          "r.created_at as created_at",
          "r.resolved_at as resolved_at",
          "u.username as user_name",
          "c.slug as category_slug",
          "c.name as category_name",
          "f.username as fulfilled_by",
        ]);

      if (query.status === "open" || query.status === "fulfilled" || query.status === "cancelled") {
        builder = builder.where("r.status", "=", query.status);
      }

      const rows = await builder.orderBy("r.created_at", "desc").limit(50).execute();

      return requestsResponse.parse({
        items: rows.map((row) => ({
          id: Number(row.id),
          user: {
            name: row.user_name ?? "未知",
            hue: hueFor(row.user_name ?? "unknown"),
          },
          title: row.title,
          description: row.description,
          category:
            row.category_slug && row.category_name
              ? { slug: row.category_slug, name: row.category_name }
              : null,
          bounty: Number(row.bounty_bonus),
          status: row.status,
          created_at: Number(row.created_at),
          resolved_at: row.resolved_at === null ? null : Number(row.resolved_at),
          fulfilled_by: row.fulfilled_by,
        })),
      });
    });

    app.post(`${API_PREFIX}/requests`, async (request, reply) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      const body = parseOrThrow(createRequestBody, request.body ?? {});
      const settings = await loadSettings(db);
      const min = settings.economy.request_min_bounty;
      const max = settings.economy.request_max_bounty;
      if (body.bounty < min || body.bounty > max) {
        throw badRequest("invalid_bounty", `悬赏需在 ${String(min)} - ${String(max)} 魔力值之间`);
      }

      const frozen =
        auth.user.bonus_frozen_until !== null && Number(auth.user.bonus_frozen_until) > Date.now();
      if (frozen) throw forbidden("bonus_frozen", "收益冻结期间不能发布求种");

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("users")
          .select("bonus")
          .where("id", "=", Number(auth.user.id))
          .executeTakeFirstOrThrow();
        if (Number(current.bonus) < body.bounty) {
          throw badRequest("insufficient_bonus", "魔力值不足");
        }

        const nextBalance = Number(current.bonus) - body.bounty;
        await trx
          .updateTable("users")
          .set({ bonus: nextBalance })
          .where("id", "=", Number(auth.user.id))
          .execute();

        await trx
          .insertInto("bonus_ledger")
          .values({
            user_id: Number(auth.user.id),
            kind: "request_escrow",
            delta: -body.bounty,
            balance_after: nextBalance,
            ref_type: "request",
            ref_id: null,
            note: body.title.slice(0, 100),
            created_at: now,
          })
          .execute();

        await trx
          .insertInto("requests")
          .values({
            user_id: Number(auth.user.id),
            title: body.title.trim(),
            description: body.description?.trim() ? body.description.trim() : null,
            category_id: body.category_id ?? null,
            bounty_bonus: body.bounty,
            status: "open",
            created_at: now,
            resolved_at: null,
            fulfilled_by: null,
          })
          .execute();
      });

      return reply.status(201).send(
        requestActionResponse.parse({
          ok: true,
          status: "open",
          message: `已发布，悬赏 ${String(body.bounty)} 魔力值已冻结`,
        }),
      );
    });

    app.post(`${API_PREFIX}/requests/:id/cancel`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      const id = Number((request.params as { id: string }).id);
      const row = await db
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw notFound("request_not_found", "求种不存在");
      if (Number(row.user_id) !== Number(auth.user.id)) {
        throw forbidden("forbidden", "只能取消自己发布的求种");
      }
      if (row.status !== "open") throw conflict("request_not_open", "该求种不在进行中");

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("users")
          .select("bonus")
          .where("id", "=", Number(auth.user.id))
          .executeTakeFirstOrThrow();
        const nextBalance = Number(current.bonus) + Number(row.bounty_bonus);

        await trx
          .updateTable("users")
          .set({ bonus: nextBalance })
          .where("id", "=", Number(auth.user.id))
          .execute();

        await trx
          .insertInto("bonus_ledger")
          .values({
            user_id: Number(auth.user.id),
            kind: "request_refund",
            delta: Number(row.bounty_bonus),
            balance_after: nextBalance,
            ref_type: "request",
            ref_id: String(id),
            note: `取消求种：${row.title.slice(0, 80)}`,
            created_at: now,
          })
          .execute();

        await trx
          .updateTable("requests")
          .set({ status: "cancelled", resolved_at: now })
          .where("id", "=", id)
          .execute();
      });

      return requestActionResponse.parse({
        ok: true,
        status: "cancelled",
        message: "已取消，悬赏已退回",
      });
    });

    app.post(`${API_PREFIX}/requests/:id/fulfill`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);

      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(fulfillRequestBody, request.body ?? {});

      const row = await db
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw notFound("request_not_found", "求种不存在");
      if (row.status !== "open") throw conflict("request_not_open", "该求种不在进行中");

      const target = await db
        .selectFrom("users")
        .select(["id", "username", "status"])
        .where("username", "=", body.username.trim())
        .executeTakeFirst();
      if (!target || target.status !== "active") throw notFound("user_not_found", "交付者不存在");
      if (Number(target.id) === Number(row.user_id)) {
        throw badRequest("fulfill_self", "不能把悬赏结算给求种人自己");
      }

      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("users")
          .select("bonus")
          .where("id", "=", target.id)
          .executeTakeFirstOrThrow();
        const nextBalance = Number(current.bonus) + Number(row.bounty_bonus);

        await trx
          .updateTable("users")
          .set({ bonus: nextBalance })
          .where("id", "=", target.id)
          .execute();

        await trx
          .insertInto("bonus_ledger")
          .values({
            user_id: Number(target.id),
            kind: "request_bounty",
            delta: Number(row.bounty_bonus),
            balance_after: nextBalance,
            ref_type: "request",
            ref_id: String(id),
            note: `求种悬赏：${row.title.slice(0, 80)}`,
            created_at: now,
          })
          .execute();

        await trx
          .updateTable("requests")
          .set({ status: "fulfilled", resolved_at: now, fulfilled_by: Number(target.id) })
          .where("id", "=", id)
          .execute();
      });

      await createNotification(db, {
        userId: Number(target.id),
        kind: "request",
        title: "求种悬赏已结算",
        body: `你被指定为求种「${row.title}」的交付者，悬赏 ${String(row.bounty_bonus)} 魔力值已到账。`,
        linkUrl: "/requests",
      });

      return requestActionResponse.parse({
        ok: true,
        status: "fulfilled",
        message: `已结算给 ${body.username.trim()}`,
      });
    });
  };
}
