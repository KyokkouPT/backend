import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  API_PREFIX,
  bonusResponse,
  exchangeResponse,
  ledgerResponse,
  rssResponse,
  type ExchangeItem,
  type LedgerEntry,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { settleBonus } from "../lib/bonus.js";
import { signDownHash } from "../lib/downhash.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { listTorrents, type TorrentSort } from "../lib/torrent-query.js";

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

function toExchangeItem(row: {
  key: string;
  name: string;
  description: string | null;
  price: number;
  inventory: number | null;
  limit_per_user: number | null;
  enabled: number;
  payload_json: string;
}): ExchangeItem {
  let payloadType = "unknown";
  try {
    const payload = JSON.parse(row.payload_json) as { type?: unknown };
    if (typeof payload.type === "string") payloadType = payload.type;
  } catch {
    /* 保持 unknown */
  }

  return {
    key: row.key,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    inventory: row.inventory === null ? null : Number(row.inventory),
    limit_per_user: row.limit_per_user === null ? null : Number(row.limit_per_user),
    enabled: Number(row.enabled) === 1,
    payload_type: payloadType,
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
      const settled = await settleBonus(db, auth.user);

      const [ledgerRows, itemRows] = await Promise.all([
        db
          .selectFrom("bonus_ledger")
          .selectAll()
          .where("user_id", "=", Number(auth.user.id))
          .orderBy("created_at", "desc")
          .limit(20)
          .execute(),
        db
          .selectFrom("exchange_items")
          .selectAll()
          .where("enabled", "=", 1)
          .orderBy("display_order", "asc")
          .execute(),
      ]);

      return bonusResponse.parse({
        balance: settled.balance,
        yield_per_hour: settled.yieldPerHour,
        frozen_until: settled.frozenUntil,
        ledger: ledgerRows.map(toLedgerEntry),
        items: itemRows.map(toExchangeItem),
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

    app.post(`${API_PREFIX}/me/exchange/:key`, async (request, reply) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      const itemKey = (request.params as { key: string }).key;
      const headerValue = request.headers["idempotency-key"];
      const idempotencyKey =
        typeof headerValue === "string" && headerValue.length > 0
          ? headerValue.slice(0, 64)
          : null;

      const item = await db
        .selectFrom("exchange_items")
        .selectAll()
        .where("key", "=", itemKey)
        .where("enabled", "=", 1)
        .executeTakeFirst();
      if (!item) throw notFound("exchange_item_not_found", "兑换项不存在");

      const now = Date.now();
      const frozen = auth.user.bonus_frozen_until !== null && Number(auth.user.bonus_frozen_until) > now;
      if (frozen) throw forbidden("bonus_frozen", "收益冻结期间不能兑换");

      if (idempotencyKey) {
        const previous = await db
          .selectFrom("redemptions")
          .selectAll()
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (previous) {
          const current = await db
            .selectFrom("users")
            .select("bonus")
            .where("id", "=", Number(auth.user.id))
            .executeTakeFirstOrThrow();
          return exchangeResponse.parse({
            ok: true,
            balance: Number(current.bonus),
            item_key: itemKey,
            message: "重复请求，已返回原兑换结果",
          });
        }
      }

      if (item.inventory !== null) {
        const used = await db
          .selectFrom("redemptions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("item_id", "=", item.id)
          .executeTakeFirst();
        if (Number(used?.count ?? 0) >= Number(item.inventory)) {
          throw conflict("out_of_stock", "兑换项库存不足");
        }
      }

      if (item.limit_per_user !== null) {
        const used = await db
          .selectFrom("redemptions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("item_id", "=", item.id)
          .where("user_id", "=", Number(auth.user.id))
          .executeTakeFirst();
        if (Number(used?.count ?? 0) >= Number(item.limit_per_user)) {
          throw conflict("limit_reached", "已达到该兑换项的个人上限");
        }
      }

      const price = Number(item.price);
      let balance = Number(auth.user.bonus);
      if (balance < price) throw badRequest("insufficient_bonus", "魔力值不足");

      let payload: { type?: string; amount?: number } = {};
      try {
        payload = JSON.parse(item.payload_json) as { type?: string; amount?: number };
      } catch {
        payload = {};
      }

      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("users")
          .select(["bonus", "uploaded"])
          .where("id", "=", Number(auth.user.id))
          .executeTakeFirstOrThrow();

        const currentBalance = Number(current.bonus);
        if (currentBalance < price) throw badRequest("insufficient_bonus", "魔力值不足");

        const nextBalance = currentBalance - price;
        const nextUploaded =
          payload.type === "upload" && typeof payload.amount === "number"
            ? Number(current.uploaded) + Math.floor(payload.amount)
            : Number(current.uploaded);

        await trx
          .updateTable("users")
          .set({ bonus: nextBalance, uploaded: nextUploaded })
          .where("id", "=", Number(auth.user.id))
          .execute();

        await trx
          .insertInto("bonus_ledger")
          .values({
            user_id: Number(auth.user.id),
            kind: "exchange",
            delta: -price,
            balance_after: nextBalance,
            ref_type: "exchange_item",
            ref_id: item.key,
            note: item.name,
            created_at: now,
          })
          .execute();

        await trx
          .insertInto("redemptions")
          .values({
            user_id: Number(auth.user.id),
            item_id: Number(item.id),
            price,
            status: "completed",
            idempotency_key: idempotencyKey,
            created_at: now,
          })
          .execute();

        balance = nextBalance;
      });

      return exchangeResponse.parse({
        ok: true,
        balance,
        item_key: itemKey,
        message: `已兑换：${item.name}`,
      });
    });

    app.get(`${API_PREFIX}/me/rss`, async (request) => {
      const auth = requireAuth(request);
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
