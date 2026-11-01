import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { sql } from "kysely";
import {
  API_PREFIX,
  bonusResponse,
  clearHnrResponse,
  exchangeBody,
  exchangeResponse,
  hnrCreditsResponse,
  ledgerResponse,
  redemptionItem,
  redemptionsResponse,
  rssResponse,
  type ExchangeItem,
  type LedgerEntry,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { evaluateBonusRate } from "../lib/bonus.js";
import { signDownHash } from "../lib/downhash.js";
import { performExchange, parseParams, toExchangeItemView } from "../lib/exchange.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { listTorrents, type TorrentSort } from "../lib/torrent-query.js";
import { parseOrThrow } from "../lib/validate.js";

const SORTS = new Set<TorrentSort>(["added_desc", "seeders_desc", "size_desc", "completed_desc"]);

function toLedgerEntry(row: {
  id: number;
  kind: string;
  delta: number;
  balance_after: number;
  note: string | null;
  created_at: number;
}): LedgerEntry {
  return {
    id: Number(row.id),
    kind: row.kind,
    delta: Number(row.delta),
    balance_after: Number(row.balance_after),
    note: row.note,
    created_at: Number(row.created_at),
  };
}

async function loadHnrCredits(
  db: Db,
  userId: number,
): Promise<{ credits: number; next_expires_at: number | null }> {
  const now = Date.now();
  const [total, next] = await Promise.all([
    db
      .selectFrom("user_credits")
      .select((eb) => eb.fn.sum<number>("quantity").as("credits"))
      .where("user_id", "=", userId)
      .where("kind", "=", "hnr_clear")
      .where("quantity", ">", 0)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
      .executeTakeFirst(),
    db
      .selectFrom("user_credits")
      .select("expires_at")
      .where("user_id", "=", userId)
      .where("kind", "=", "hnr_clear")
      .where("quantity", ">", 0)
      .where("expires_at", "is not", null)
      .where("expires_at", ">", now)
      .orderBy("expires_at", "asc")
      .executeTakeFirst(),
  ]);
  return {
    credits: Number(total?.credits ?? 0),
    next_expires_at: next?.expires_at === null || next?.expires_at === undefined ? null : Number(next.expires_at),
  };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

const RSS_SORT = new Set<string>(["added_desc", "seeders_desc", "size_desc", "completed_desc"]);

function buildRssFilters(query: Record<string, unknown>) {
  const text = (key: string): string | undefined =>
    typeof query[key] === "string" && (query[key] as string).length > 0
      ? (query[key] as string)
      : undefined;
  const numbers = (key: string): number | undefined => {
    const raw = text(key);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const sortText = text("sort") ?? "added_desc";
  const fields: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("field.") && typeof value === "string" && value.length > 0) {
      fields.push([key.slice("field.".length), value]);
    }
  }

  return {
    limit: Math.min(Math.max(numbers("limit") ?? 30, 1), 100),
    sort: (RSS_SORT.has(sortText) ? sortText : "added_desc") as TorrentSort,
    fields,
    ...(text("section") ? { section: text("section") } : {}),
    ...(text("cat") ?? text("category") ? { category: text("cat") ?? text("category") } : {}),
    ...(text("promo") ? { promo: text("promo") } : {}),
    ...(text("q") ? { q: text("q") } : {}),
    ...(numbers("since") !== undefined ? { since: numbers("since") } : {}),
    ...(numbers("until") !== undefined ? { until: numbers("until") } : {}),
  };
}

export function economyRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;

    app.get(`${API_PREFIX}/me/bonus`, async (request) => {
      const auth = requireAuth(request);
      const userId = Number(auth.user.id);
      const bonusRate = await evaluateBonusRate(db, auth.user);

      const [ledgerRows, itemRows, usedRows, userUsedRows] = await Promise.all([
        db
          .selectFrom("bonus_ledger")
          .selectAll()
          .where("user_id", "=", userId)
          .orderBy("created_at", "desc")
          .limit(20)
          .execute(),
        db
          .selectFrom("exchange_items")
          .selectAll()
          .where("enabled", "=", 1)
          .where("type", "is not", null)
          .orderBy("display_order", "asc")
          .execute(),
        db
          .selectFrom("redemptions")
          .select(["item_id"])
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("status", "=", "completed")
          .groupBy("item_id")
          .execute(),
        db
          .selectFrom("redemptions")
          .select(["item_id"])
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("status", "=", "completed")
          .where("user_id", "=", userId)
          .groupBy("item_id")
          .execute(),
      ]);
      const usedById = new Map(usedRows.map((row) => [Number(row.item_id), Number(row.count)]));
      const userUsedById = new Map(
        userUsedRows.map((row) => [Number(row.item_id), Number(row.count)]),
      );
      const items = itemRows
        .map((row) =>
          toExchangeItemView(row, {
            balance: Number(auth.user.bonus),
            user: auth.user,
            used: usedById.get(Number(row.id)) ?? 0,
            userUsed: userUsedById.get(Number(row.id)) ?? 0,
          }),
        )
        .filter((item): item is ExchangeItem => item !== null);

      return bonusResponse.parse({
        balance: Number(auth.user.bonus),
        yield_per_hour: bonusRate.rate,
        frozen_until: bonusRate.frozen ? auth.user.bonus_frozen_until : null,
        ledger: ledgerRows.map(toLedgerEntry),
        items,
      });
    });

    app.get(`${API_PREFIX}/me/ledger`, async (request) => {
      const auth = requireAuth(request);
      const rows = await db
        .selectFrom("bonus_ledger")
        .selectAll()
        .where("user_id", "=", Number(auth.user.id))
        .orderBy("created_at", "desc")
        .limit(50)
        .execute();

      return ledgerResponse.parse({ items: rows.map(toLedgerEntry) });
    });

    app.post(`${API_PREFIX}/me/exchange/:key`, async (request) => {
      const auth = requireAuth(request);
      if (!auth.permissions.includes("bonus.exchange")) {
        throw forbidden("forbidden", "当前等级不能兑换");
      }
      assertCsrf(request, auth.session);
      const body = parseOrThrow(exchangeBody, request.body ?? {});
      const headerValue = request.headers["idempotency-key"];
      const idempotencyKey =
        body.idempotency_key?.trim() ||
        (typeof headerValue === "string" ? headerValue.trim() : "") ||
        null;
      const result = await performExchange(db, {
        userId: Number(auth.user.id),
        classRank: auth.class ? Number(auth.class.rank) : 0,
        itemKey: (request.params as { key: string }).key,
        params: (body.params ?? {}) as Record<string, unknown>,
        idempotencyKey: idempotencyKey ? idempotencyKey.slice(0, 64) : null,
        actorId: Number(auth.user.id),
        useRowLocks: config.databaseDriver !== "sqlite",
      });
      return exchangeResponse.parse({
        ok: true,
        balance: result.balance,
        item_key: result.itemKey,
        redemption_id: result.redemptionId,
        status: "completed",
        message: result.message,
      });
    });

    app.get(`${API_PREFIX}/me/redemptions`, async (request) => {
      const auth = requireAuth(request);
      const rows = await db
        .selectFrom("redemptions as r")
        .leftJoin("users as actor", "actor.id", "r.actor_id")
        .select([
          "r.id as id",
          "r.item_id as item_id",
          "r.item_key as item_key",
          "r.type as type",
          "r.status as status",
          "r.price as price",
          "r.params_json as params_json",
          "r.actor_id as actor_id",
          "r.created_at as created_at",
          "actor.username as actor",
        ])
        .where("r.user_id", "=", Number(auth.user.id))
        .where("r.status", "in", ["completed", "failed"])
        .orderBy("r.created_at", "desc")
        .limit(50)
        .execute();

      return redemptionsResponse.parse({
        items: rows.map((row) =>
          redemptionItem.parse({
            id: Number(row.id),
            item_id: Number(row.item_id),
            item_key: row.item_key,
            type: row.type ?? "unknown",
            status: row.status,
            price: Number(row.price),
            params: parseParams(row.params_json),
            actor: row.actor ?? null,
            created_at: Number(row.created_at),
          }),
        ),
      });
    });

    app.get(`${API_PREFIX}/me/hnr/credits`, async (request) => {
      const auth = requireAuth(request);
      const summary = await loadHnrCredits(db, Number(auth.user.id));
      return hnrCreditsResponse.parse(summary);
    });

    app.post(`${API_PREFIX}/me/hnr/:id/clear`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const userId = Number(auth.user.id);
      const obligationId = Number((request.params as { id: string }).id);
      if (!Number.isInteger(obligationId) || obligationId <= 0) {
        throw badRequest("invalid_obligation", "H&R 记录无效");
      }

      const now = Date.now();
      const lockIf = <T>(query: T): T =>
        config.databaseDriver === "sqlite"
          ? query
          : (query as T & { forUpdate: () => T }).forUpdate();
      const credits = await db.transaction().execute(async (trx) => {
        const obligation = await lockIf(
          trx
            .selectFrom("hnr_obligations")
            .select(["id", "status"])
            .where("id", "=", obligationId)
            .where("user_id", "=", userId),
        ).executeTakeFirst();
        if (!obligation) throw notFound("hnr_not_found", "H&R 记录不存在");
        if (obligation.status !== "unreached") {
          throw conflict("hnr_not_clearable", "只能清除未完成的 H&R 记录");
        }

        const credit = await lockIf(
          trx
            .selectFrom("user_credits")
            .select(["id", "quantity"])
            .where("user_id", "=", userId)
            .where("kind", "=", "hnr_clear")
            .where("quantity", ">", 0)
            .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
            .orderBy(sql`case when expires_at is null then 1 else 0 end`, "asc")
            .orderBy("expires_at", "asc"),
        ).executeTakeFirst();
        if (!credit) throw conflict("hnr_credit_missing", "没有可用的 H&R 清除机会");

        await trx
          .updateTable("user_credits")
          .set({ quantity: Number(credit.quantity) - 1 })
          .where("id", "=", credit.id)
          .execute();
        const updated = await trx
          .updateTable("hnr_obligations")
          .set({ status: "cleared", resolved_at: now })
          .where("id", "=", obligation.id)
          .where("user_id", "=", userId)
          .where("status", "=", "unreached")
          .execute();
        if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
          throw conflict("hnr_not_clearable", "H&R 记录状态已变化");
        }

        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: userId,
            action: "hnr.clear",
            target_type: "hnr_obligation",
            target_id: String(obligation.id),
            detail_json: JSON.stringify({ credit_id: credit.id }),
            ip: request.ip,
            created_at: now,
          })
          .execute();

        const remaining = await trx
          .selectFrom("user_credits")
          .select((eb) => eb.fn.sum<number>("quantity").as("credits"))
          .where("user_id", "=", userId)
          .where("kind", "=", "hnr_clear")
          .where("quantity", ">", 0)
          .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
          .executeTakeFirst();
        return Number(remaining?.credits ?? 0);
      });

      return clearHnrResponse.parse({
        ok: true,
        credits,
        message: "已清除该条 H&R 记录",
      });
    });

    app.get(`${API_PREFIX}/me/rss`, async (request) => {
      const auth = requireAuth(request);
      if (!auth.permissions.includes("rss.read")) {
        throw forbidden("forbidden", "当前等级不能使用 RSS");
      }
      return rssResponse.parse({
        url: `${config.baseUrl}/rss?passkey=${auth.user.passkey}`,
      });
    });

    const rssHandler = async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      reply.header("cache-control", "private, no-store");
      reply.type("application/rss+xml; charset=utf-8");

      const query = request.query as Record<string, unknown>;
      const passkey = typeof query.passkey === "string" ? query.passkey : "";
      if (!passkey) {
        return reply.status(401).send("missing passkey");
      }

      const user = await db
        .selectFrom("users")
        .select(["id", "passkey", "status"])
        .where("passkey", "=", passkey)
        .executeTakeFirst();
      if (!user || user.status !== "active") {
        return reply.status(403).send("invalid passkey");
      }

      const settings = await loadSettings(db);
      const filters = buildRssFilters(query);
      const result = await listTorrents(db, filters, Number(user.id));

      const items = result.items
        .map((torrent) => {
          const downhash = signDownHash(
            config.sessionSecret,
            user.passkey,
            Number(user.id),
            torrent.id,
          );
          const link = `${config.baseUrl}/t/${String(torrent.id)}`;
          const enclosure = `${link}/download?downhash=${encodeURIComponent(downhash)}`;
          return [
            "<item>",
            `<title>${escapeXml(torrent.name)}</title>`,
            `<link>${escapeXml(link)}</link>`,
            `<guid isPermaLink="false">kyokkou:t${String(torrent.id)}</guid>`,
            `<pubDate>${new Date(torrent.created_at).toUTCString()}</pubDate>`,
            `<category>${escapeXml(torrent.section.name)}</category>`,
            `<enclosure url="${escapeXml(enclosure)}" length="${String(torrent.size)}" type="application/x-bittorrent"/>`,
            "</item>",
          ].join("");
        })
        .join("");

      const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<rss version="2.0">',
        "<channel>",
        `<title>${escapeXml(settings.site.name)}</title>`,
        `<link>${escapeXml(config.baseUrl)}</link>`,
        `<description>${escapeXml(settings.site.tagline)}</description>`,
        items,
        "</channel>",
        "</rss>",
      ].join("");

      return reply.send(xml);
    };

    app.get("/rss", rssHandler);
    app.get("/rss.xml", rssHandler);
  };
}
