import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  PERMISSIONS,
  staffExchangeItem,
  staffExchangeItemCreateBody,
  staffExchangeItemUpdateBody,
  staffExchangeItemsResponse,
  type StaffExchangeItem,
  type StaffExchangeItemUpdateBody,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import type { Selectable } from "kysely";
import type { ExchangeItemsTable } from "../db/types.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";
import { giftPrice, exchangeDirectionFor, isExchangeType, parseParams } from "../lib/exchange.js";

function requireShop(request: Parameters<typeof requireAuth>[0]) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(PERMISSIONS.staffBonusShop)) {
    throw new HttpProblem(403, "forbidden", "没有魔力值商店管理权限");
  }
  return auth;
}

function positiveOrNull(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw badRequest("invalid_item", `${field} 必须为正整数`);
  return value;
}

type ItemBody = StaffExchangeItemUpdateBody;

function normalizeBody(body: ItemBody): {
  direction: string;
  type: string;
  amount: number | null;
  price: number;
  paramsJson: string | null;
  inventory: number | null;
  limitPerUser: number | null;
  enabled: number;
  displayOrder: number;
  minClassRank: number | null;
} {
  if (!isExchangeType(body.type)) throw badRequest("invalid_item_type", "未知兑换类型");
  const direction = exchangeDirectionFor(body.type);
  if (body.direction !== direction) {
    throw badRequest("invalid_item_direction", "兑换方向与类型不匹配");
  }

  const inviteTypes = new Set(["invite_add", "invite_sell"]);
  const trafficTypes = new Set([
    "upload_add",
    "download_add",
    "download_reduce",
    "upload_sell",
  ]);
  const noAmountTypes = new Set(["title_set", "username_change"]);
  let amount: number | null = null;
  if (inviteTypes.has(body.type)) amount = 1;
  else if (trafficTypes.has(body.type) || body.type === "gift_bonus" || body.type === "hnr_clear") {
    amount = positiveOrNull(body.amount, "amount");
    if (amount === null) throw badRequest("invalid_item", "amount 不能为空");
  } else if (!noAmountTypes.has(body.type) && body.amount != null) {
    throw badRequest("invalid_item", "该类型不接受 amount");
  }

  const params: Record<string, unknown> = { ...(body.params ?? {}) };
  let price = Number(body.price);
  if (body.type === "title_set") {
    const max = params.max_length === undefined ? 32 : Number(params.max_length);
    if (!Number.isInteger(max) || max < 1 || max > 64) {
      throw badRequest("invalid_item", "max_length 需为 1–64");
    }
    params.max_length = max;
    price = Number(body.price);
  } else if (body.type === "gift_bonus") {
    const fee = params.fee_ratio === undefined ? 0 : Number(params.fee_ratio);
    if (!Number.isFinite(fee) || fee < 0 || fee > 10) {
      throw badRequest("invalid_item", "fee_ratio 需在 0–10 之间");
    }
    params.fee_ratio = fee;
    if (amount === null || amount <= 0) throw badRequest("invalid_item", "礼物数量无效");
    price = giftPrice(amount, fee);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw badRequest("invalid_item", "价格必须大于 0");
  }
  if (body.min_class_rank !== undefined && body.min_class_rank !== null && body.min_class_rank < 0) {
    throw badRequest("invalid_item", "最低等级 rank 无效");
  }

  return {
    direction,
    type: body.type,
    amount,
    price,
    paramsJson: Object.keys(params).length > 0 ? JSON.stringify(params) : null,
    inventory: positiveOrNull(body.inventory, "inventory"),
    limitPerUser: positiveOrNull(body.limit_per_user, "limit_per_user"),
    enabled: body.enabled === false ? 0 : 1,
    displayOrder: Number.isInteger(body.display_order) ? Number(body.display_order) : 0,
    minClassRank: body.min_class_rank ?? null,
  };
}

function toStaffItem(
  row: Selectable<ExchangeItemsTable>,
  used: number,
): StaffExchangeItem {
  const type = row.type && isExchangeType(row.type) ? row.type : null;
  return staffExchangeItem.parse({
    id: Number(row.id),
    key: row.key,
    name: row.name,
    description: row.description,
    direction: row.direction === "sell" ? "sell" : "buy",
    type: type ?? row.type ?? "unknown",
    amount: row.amount === null ? null : Number(row.amount),
    params: parseParams(row.params_json),
    price: Number(row.price),
    inventory: row.inventory === null ? null : Number(row.inventory),
    limit_per_user: row.limit_per_user === null ? null : Number(row.limit_per_user),
    enabled: Number(row.enabled) === 1,
    display_order: Number(row.display_order),
    min_class_rank: row.min_class_rank === null ? null : Number(row.min_class_rank),
    used,
    remaining:
      row.inventory === null ? null : Math.max(0, Number(row.inventory) - used),
  });
}

export function bonusShopRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    const loadUsed = async (itemIds: number[]): Promise<Map<number, number>> => {
      if (itemIds.length === 0) return new Map();
      const rows = await db
        .selectFrom("redemptions")
        .select(["item_id"])
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("item_id", "in", itemIds)
        .where("status", "=", "completed")
        .groupBy("item_id")
        .execute();
      return new Map(rows.map((row) => [Number(row.item_id), Number(row.count)]));
    };

    app.get(`${API_PREFIX}/staff/bonus/items`, async (request) => {
      requireShop(request);
      const rows = await db
        .selectFrom("exchange_items")
        .selectAll()
        .orderBy("display_order", "asc")
        .orderBy("id", "asc")
        .execute();
      const used = await loadUsed(rows.map((row) => Number(row.id)));
      return staffExchangeItemsResponse.parse({
        items: rows.map((row) => toStaffItem(row, used.get(Number(row.id)) ?? 0)),
      });
    });

    app.post(`${API_PREFIX}/staff/bonus/items`, async (request, reply) => {
      const auth = requireShop(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffExchangeItemCreateBody, request.body ?? {});
      const normalized = normalizeBody(body);
      const existing = await db
        .selectFrom("exchange_items")
        .select("id")
        .where("key", "=", body.key)
        .executeTakeFirst();
      if (existing) throw conflict("exchange_key_taken", "兑换项 key 已存在");

      const now = Date.now();
      const inserted = await db
        .insertInto("exchange_items")
        .values({
          key: body.key,
          name: body.name.trim(),
          description: body.description?.trim() || null,
          price: normalized.price,
          inventory: normalized.inventory,
          limit_per_user: normalized.limitPerUser,
          enabled: normalized.enabled,
          payload_json: "{}",
          display_order: normalized.displayOrder,
          direction: normalized.direction,
          type: normalized.type,
          amount: normalized.amount,
          params_json: normalized.paramsJson,
          min_class_rank: normalized.minClassRank,
        })
        .executeTakeFirstOrThrow();

      const created = await db
        .selectFrom("exchange_items")
        .selectAll()
        .where("key", "=", body.key)
        .executeTakeFirstOrThrow();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "bonus_shop.item_create",
          target_type: "exchange_item",
          target_id: String(created.id),
          detail_json: JSON.stringify({ key: created.key, type: normalized.type }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      void inserted;
      return reply.status(201).send(staffExchangeItem.parse(toStaffItem(created, 0)));
    });

    app.put(`${API_PREFIX}/staff/bonus/items/:id`, async (request) => {
      const auth = requireShop(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const existing = await db
        .selectFrom("exchange_items")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!existing) throw notFound("exchange_item_not_found", "兑换项不存在");
      const body = parseOrThrow(staffExchangeItemUpdateBody, request.body ?? {});
      const normalized = normalizeBody(body);
      const now = Date.now();
      await db
        .updateTable("exchange_items")
        .set({
          name: body.name.trim(),
          description: body.description?.trim() || null,
          price: normalized.price,
          inventory: normalized.inventory,
          limit_per_user: normalized.limitPerUser,
          enabled: normalized.enabled,
          display_order: normalized.displayOrder,
          direction: normalized.direction,
          type: normalized.type,
          amount: normalized.amount,
          params_json: normalized.paramsJson,
          min_class_rank: normalized.minClassRank,
        })
        .where("id", "=", id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "bonus_shop.item_update",
          target_type: "exchange_item",
          target_id: String(id),
          detail_json: JSON.stringify({
            before: {
              key: existing.key,
              name: existing.name,
              direction: existing.direction,
              type: existing.type,
              price: Number(existing.price),
            },
            after: {
              name: body.name,
              direction: normalized.direction,
              type: normalized.type,
              price: normalized.price,
            },
          }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      const used = await loadUsed([id]);
      const updated = await db
        .selectFrom("exchange_items")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return staffExchangeItem.parse(toStaffItem(updated, used.get(id) ?? 0));
    });

    app.post(`${API_PREFIX}/staff/bonus/items/:id/toggle`, async (request) => {
      const auth = requireShop(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const existing = await db
        .selectFrom("exchange_items")
        .select(["id", "enabled", "key"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!existing) throw notFound("exchange_item_not_found", "兑换项不存在");
      const next = Number(existing.enabled) === 1 ? 0 : 1;
      await db.updateTable("exchange_items").set({ enabled: next }).where("id", "=", id).execute();
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "bonus_shop.item_toggle",
          target_type: "exchange_item",
          target_id: String(id),
          detail_json: JSON.stringify({ key: existing.key, enabled: next === 1 }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();
      return { ok: true, enabled: next === 1 };
    });
  };
}
