import type { Kysely, Selectable } from "kysely";
import type { ExchangeDirection, ExchangeRequirement, ExchangeType } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import type { ClassesTable, Database, ExchangeItemsTable, UsersTable } from "../db/types.js";
import { HttpProblem } from "./problem.js";
import { loadSettings } from "./settings.js";
import { createNotification } from "./notifications.js";
import { normalizeUsername } from "./username.js";
import {
  UsernameChangeError,
  applyUsernameChangeTx,
} from "./username-change.js";

type ItemRow = Selectable<ExchangeItemsTable>;
type UserRow = Selectable<UsersTable>;

export const EXCHANGE_TYPES: ExchangeType[] = [
  "upload_add",
  "download_add",
  "download_reduce",
  "invite_add",
  "title_set",
  "gift_bonus",
  "username_change",
  "hnr_clear",
  "invite_sell",
  "upload_sell",
];

const BUY_TYPES = new Set<ExchangeType>([
  "upload_add",
  "download_add",
  "download_reduce",
  "invite_add",
  "title_set",
  "gift_bonus",
  "username_change",
  "hnr_clear",
]);
const SELL_TYPES = new Set<ExchangeType>(["invite_sell", "upload_sell"]);

export function exchangeDirectionFor(type: ExchangeType): ExchangeDirection {
  return BUY_TYPES.has(type) ? "buy" : "sell";
}

export function isExchangeType(value: string): value is ExchangeType {
  return (EXCHANGE_TYPES as string[]).includes(value);
}

export function exchangeRequires(type: ExchangeType): ExchangeRequirement[] {
  if (type === "title_set") return ["title"];
  if (type === "gift_bonus") return ["recipient", "message"];
  if (type === "username_change") return ["username"];
  return [];
}

export function parseParams(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function giftPrice(amount: number, feeRatio: number): number {
  return Math.floor(amount * (1 + feeRatio));
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function effectivePrice(item: ItemRow): number {
  if (item.type === "gift_bonus") {
    const amount = Number(item.amount ?? 0);
    const fee = Number(parseParams(item.params_json).fee_ratio ?? 0);
    return giftPrice(amount, Number.isFinite(fee) ? fee : 0);
  }
  return Number(item.price);
}

export type ExchangeResult = {
  redemptionId: number;
  balance: number;
  itemKey: string;
  message: string;
};

export type PerformExchangeInput = {
  userId: number;
  classRank: number;
  itemKey: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
  actorId?: number | null;
  useRowLocks?: boolean;
};

function withLock<T>(query: T, enabled: boolean | undefined): T {
  if (!enabled) return query;
  return (query as T & { forUpdate: () => T }).forUpdate();
}

/**
 * 统一兑换入口。事务内校验/扣款/发资源/写账本/写兑换记录；
 * 事务回滚后在事务外补写 failed 记录，failed 不占幂等键/库存/上限。
 */
export async function performExchange(
  db: Db,
  input: PerformExchangeInput,
): Promise<ExchangeResult> {
  const settings = await loadSettings(db);
  const now = Date.now();
  const item = await db
    .selectFrom("exchange_items")
    .selectAll()
    .where("key", "=", input.itemKey)
    .executeTakeFirst();
  if (!item) throw new HttpProblem(404, "exchange_item_not_found", "兑换项不存在");

  try {
    return await db.transaction().execute(async (trx) => {
      const lockedItem = await withLock(
        trx
          .selectFrom("exchange_items")
          .selectAll()
          .where("id", "=", item.id),
        input.useRowLocks,
      ).executeTakeFirst();
      if (!lockedItem || Number(lockedItem.enabled) !== 1) {
        throw new HttpProblem(409, "exchange_item_disabled", "兑换项已停用");
      }

      const type = lockedItem.type;
      if (!type || !isExchangeType(type)) {
        throw new HttpProblem(400, "invalid_item_type", "兑换项类型无效");
      }
      const expectedDirection = exchangeDirectionFor(type);
      if (lockedItem.direction !== expectedDirection) {
        throw new HttpProblem(400, "invalid_item_direction", "兑换方向与类型不匹配");
      }
      if (lockedItem.min_class_rank !== null && input.classRank < Number(lockedItem.min_class_rank)) {
        throw new HttpProblem(403, "class_rank_too_low", "当前等级不能兑换该商品");
      }

      const user = await withLock(
        trx
          .selectFrom("users")
          .selectAll()
          .where("id", "=", input.userId),
        input.useRowLocks,
      ).executeTakeFirstOrThrow();
      if (user.status !== "active") throw new HttpProblem(403, "user_inactive", "账号不可用");
      if (user.bonus_frozen_until !== null && Number(user.bonus_frozen_until) > now) {
        throw new HttpProblem(403, "bonus_frozen", "收益冻结期间不能兑换");
      }

      if (input.idempotencyKey) {
        const previous = await trx
          .selectFrom("redemptions")
          .selectAll()
          .where("user_id", "=", input.userId)
          .where("idempotency_key", "=", input.idempotencyKey)
          .where("status", "=", "completed")
          .executeTakeFirst();
        if (previous) {
          return {
            redemptionId: Number(previous.id),
            balance: Number(user.bonus),
            itemKey: previous.item_key ?? lockedItem.key,
            message: "重复请求，已返回原兑换结果",
          };
        }
      }

      await assertInventoryAndLimit(trx, lockedItem, input.userId);

      const applied = await applyType(trx, {
        item: lockedItem,
        type,
        user,
        params: input.params,
        settings,
        now,
        useRowLocks: input.useRowLocks,
      });

      await writeLedger(trx, {
        item: lockedItem,
        type,
        userId: input.userId,
        applied,
        now,
      });

      const redemption = await trx
        .insertInto("redemptions")
        .values({
          user_id: input.userId,
          item_id: Number(lockedItem.id),
          item_key: lockedItem.key,
          type,
          params_json: JSON.stringify(applied.recordParams),
          price: applied.price,
          status: "completed",
          actor_id: input.actorId ?? input.userId,
          idempotency_key: input.idempotencyKey,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      let redemptionId = Number(redemption.insertId ?? 0);
      if (!redemptionId) {
        const insertedRow = await trx
          .selectFrom("redemptions")
          .select("id")
          .where("user_id", "=", input.userId)
          .where("item_id", "=", lockedItem.id)
          .where("status", "=", "completed")
          .orderBy("id", "desc")
          .executeTakeFirst();
        redemptionId = Number(insertedRow?.id ?? 0);
      }

      if (type === "gift_bonus") {
        await createNotification(trx as unknown as Db, {
          userId: Number(applied.recipientId ?? 0),
          kind: "account",
          title: "收到魔力值赠送",
          body: `你收到 ${String(applied.recordParams.amount ?? 0)} 魔力值，来自 ${user.username}。${String(
            applied.recordParams.message ?? "",
          )}`,
          linkUrl: "/me/bonus",
        });
      }

      await trx
        .insertInto("audit_logs")
        .values({
          actor_id: input.actorId ?? input.userId,
          action: "bonus_shop.exchange",
          target_type: "user",
          target_id: String(input.userId),
          detail_json: JSON.stringify({
            item: lockedItem.key,
            type,
            price: applied.price,
            params: applied.recordParams,
          }),
          ip: null,
          created_at: now,
        })
        .execute();

      return {
        redemptionId: Number(redemptionId ?? 0),
        balance: applied.balance,
        itemKey: lockedItem.key,
        message: type === "gift_bonus" ? "赠送成功" : `已兑换：${lockedItem.name}`,
      };
    });
  } catch (error) {
    const problem = toProblem(error);
    if (problem.code === "idempotency_conflict" && input.idempotencyKey) {
      const previous = await db
        .selectFrom("redemptions")
        .select(["id", "item_key"])
        .where("user_id", "=", input.userId)
        .where("idempotency_key", "=", input.idempotencyKey)
        .where("status", "=", "completed")
        .executeTakeFirst();
      if (previous) {
        const current = await db
          .selectFrom("users")
          .select("bonus")
          .where("id", "=", input.userId)
          .executeTakeFirstOrThrow();
        return {
          redemptionId: Number(previous.id),
          balance: Number(current.bonus),
          itemKey: previous.item_key ?? item.key,
          message: "重复请求，已返回原兑换结果",
        };
      }
    }
    await writeFailedRecord(db, {
      item,
      userId: input.userId,
      actorId: input.actorId ?? input.userId,
      params: input.params,
      problem,
      now,
    }).catch(() => undefined);
    throw problem;
  }
}

async function assertInventoryAndLimit(
  trx: Kysely<Database>,
  item: Selectable<ExchangeItemsTable>,
  userId: number,
): Promise<void> {
  if (item.inventory !== null) {
    const used = await trx
      .selectFrom("redemptions")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("item_id", "=", item.id)
      .where("status", "=", "completed")
      .executeTakeFirst();
    if (Number(used?.count ?? 0) >= Number(item.inventory)) {
      throw new HttpProblem(409, "out_of_stock", "兑换项库存不足");
    }
  }
  if (item.limit_per_user !== null) {
    const used = await trx
      .selectFrom("redemptions")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("item_id", "=", item.id)
      .where("user_id", "=", userId)
      .where("status", "=", "completed")
      .executeTakeFirst();
    if (Number(used?.count ?? 0) >= Number(item.limit_per_user)) {
      throw new HttpProblem(409, "limit_reached", "已达到该兑换项的个人上限");
    }
  }
}

type Applied = {
  price: number;
  balance: number;
  recipientId?: number;
  ledgerDelta?: number;
  recordParams: Record<string, unknown>;
};

async function applyType(
  trx: Kysely<Database>,
  ctx: {
    item: Selectable<ExchangeItemsTable>;
    type: ExchangeType;
    user: Selectable<UsersTable>;
    params: Record<string, unknown>;
    settings: Awaited<ReturnType<typeof loadSettings>>;
    now: number;
    useRowLocks?: boolean;
  },
): Promise<Applied> {
  const { item, type, user, params, settings, now } = ctx;
  const amount = Number(item.amount ?? 0);
  const price = effectivePrice(item);
  const paramsJson = parseParams(item.params_json);
  let balance = Number(user.bonus);

  if (type === "upload_add") {
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "上传额度无效");
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    await trx
      .updateTable("users")
      .set({ bonus: balance, uploaded: Number(user.uploaded) + amount })
      .where("id", "=", user.id)
      .execute();
    return { price, balance, recordParams: { amount, price } };
  }

  if (type === "download_add") {
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "下载额度无效");
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    await trx
      .updateTable("users")
      .set({ bonus: balance, downloaded: Number(user.downloaded) + amount })
      .where("id", "=", user.id)
      .execute();
    return { price, balance, recordParams: { amount, price } };
  }

  if (type === "download_reduce") {
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "减免额度无效");
    if (Number(user.downloaded) < amount) {
      throw new HttpProblem(400, "insufficient_download", "减免额度超过当前计入下载量");
    }
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    await trx
      .updateTable("users")
      .set({ bonus: balance, downloaded: Number(user.downloaded) - amount })
      .where("id", "=", user.id)
      .execute();
    return { price, balance, recordParams: { amount, price } };
  }

  if (type === "invite_add") {
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    await trx
      .updateTable("users")
      .set({ bonus: balance, invite_balance: Number(user.invite_balance) + 1 })
      .where("id", "=", user.id)
      .execute();
    return { price, balance, recordParams: { amount: 1, price } };
  }

  if (type === "title_set") {
    const maxLength = Number(paramsJson.max_length ?? 32);
    const title = stringValue(params.title);
    if (title.length < 1 || title.length > maxLength) {
      throw new HttpProblem(400, "invalid_title", `头衔长度需为 1–${String(maxLength)}`);
    }
    if (/[\u0000-\u001f\u007f]/.test(title) || /\p{Extended_Pictographic}/u.test(title)) {
      throw new HttpProblem(400, "invalid_title", "头衔不能包含控制字符或 emoji");
    }
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    await trx
      .updateTable("users")
      .set({ bonus: balance, custom_title: title })
      .where("id", "=", user.id)
      .execute();
    return { price, balance, recordParams: { title, max_length: maxLength, price } };
  }

  if (type === "gift_bonus") {
    const recipientName = normalizeUsername(stringValue(params.recipient));
    const message = stringValue(params.message);
    if (!recipientName) throw new HttpProblem(400, "recipient_required", "请填写接收者用户名");
    if (message.length > settings.shop.gift_message_max_length) {
      throw new HttpProblem(400, "gift_message_too_long", "留言过长");
    }
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "赠送数值无效");
    if (settings.shop.gift_max_per_transaction >= 0 && amount > settings.shop.gift_max_per_transaction) {
      throw new HttpProblem(400, "gift_too_large", "超过单次赠送上限");
    }
    const feeRatio = Number(paramsJson.fee_ratio ?? 0);
    const charge = giftPrice(amount, Number.isFinite(feeRatio) ? feeRatio : 0);
    if (recipientName === normalizeUsername(user.username)) {
      throw new HttpProblem(400, "gift_self", "不能给自己赠送");
    }
    const recipient = await withLock(
      trx
        .selectFrom("users")
        .selectAll()
        .where("username", "=", recipientName),
      ctx.useRowLocks,
    ).executeTakeFirst();
    if (!recipient || recipient.status !== "active") {
      throw new HttpProblem(404, "recipient_not_found", "接收者不存在或不可用");
    }
    if (balance < charge) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    const nextSender = balance - charge;
    const nextRecipient = Number(recipient.bonus) + amount;
    await trx
      .updateTable("users")
      .set({ bonus: nextSender })
      .where("id", "=", user.id)
      .execute();
    await trx
      .updateTable("users")
      .set({ bonus: nextRecipient })
      .where("id", "=", recipient.id)
      .execute();
    await trx
      .insertInto("bonus_ledger")
      .values({
        user_id: Number(recipient.id),
        kind: "gift_received",
        delta: amount,
        balance_after: nextRecipient,
        ref_type: "gift",
        ref_id: String(item.key),
        note: `收到 ${user.username} 的赠送`,
        created_at: now,
      })
      .execute();
    return {
      price: charge,
      balance: nextSender,
      recipientId: Number(recipient.id),
      recordParams: {
        recipient: recipientName,
        message,
        amount,
        fee_ratio: feeRatio,
        price: charge,
      },
    };
  }

  if (type === "username_change") {
    if (balance < price) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    const changed = await applyUsernameChangeTx(trx, {
      userId: Number(user.id),
      newUsername: stringValue(params.username),
      price,
      itemId: Number(item.id),
      actorId: Number(user.id),
    }, { manageBonus: false, settings });
    const nextBalance = changed.reverted ? balance + changed.refund : balance - price;
    await trx
      .updateTable("users")
      .set({ bonus: nextBalance })
      .where("id", "=", Number(user.id))
      .execute();
    return {
      price: changed.reverted ? 0 : price,
      balance: nextBalance,
      ledgerDelta: changed.reverted ? changed.refund : undefined,
      recordParams: {
        username: changed.username,
        reverted: changed.reverted,
        refund: changed.refund,
        price,
      },
    };
  }

  if (type === "hnr_clear") {
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "清除次数无效");
    balance -= price;
    if (balance < 0) throw new HttpProblem(400, "insufficient_bonus", "魔力值不足");
    const expiresAt =
      settings.shop.hnr_credit_expire_days < 0
        ? null
        : now + settings.shop.hnr_credit_expire_days * 86_400_000;
    await trx
      .updateTable("users")
      .set({ bonus: balance })
      .where("id", "=", user.id)
      .execute();
    await trx
      .insertInto("user_credits")
      .values({
        user_id: Number(user.id),
        kind: "hnr_clear",
        quantity: amount,
        expires_at: expiresAt,
        source_redemption_id: null,
        created_at: now,
      })
      .execute();
    return { price, balance, recordParams: { amount, expires_at: expiresAt, price } };
  }

  if (type === "invite_sell") {
    if (Number(user.invite_balance) < 1) {
      throw new HttpProblem(400, "insufficient_invites", "邀请名额不足");
    }
    const nextBalance = balance + price;
    await trx
      .updateTable("users")
      .set({ bonus: nextBalance, invite_balance: Number(user.invite_balance) - 1 })
      .where("id", "=", user.id)
      .execute();
    return { price, balance: nextBalance, recordParams: { amount: 1, price } };
  }

  if (type === "upload_sell") {
    if (amount <= 0) throw new HttpProblem(400, "invalid_amount", "出售上传量无效");
    if (Number(user.uploaded) < amount) {
      throw new HttpProblem(400, "insufficient_upload", "上传量不足");
    }
    const nextBalance = balance + price;
    await trx
      .updateTable("users")
      .set({ bonus: nextBalance, uploaded: Number(user.uploaded) - amount })
      .where("id", "=", user.id)
      .execute();
    return { price, balance: nextBalance, recordParams: { amount, price } };
  }

  throw new HttpProblem(400, "invalid_item_type", "兑换类型无效");
}

async function writeLedger(
  trx: Kysely<Database>,
  ctx: {
    item: Selectable<ExchangeItemsTable>;
    type: ExchangeType;
    userId: number;
    applied: Applied;
    now: number;
  },
): Promise<void> {
  const delta =
    ctx.applied.ledgerDelta ??
    (ctx.type === "invite_sell" || ctx.type === "upload_sell"
      ? ctx.applied.price
      : -ctx.applied.price);
  if (delta === 0) return;
  await trx
    .insertInto("bonus_ledger")
    .values({
      user_id: ctx.userId,
      kind: ctx.type === "invite_sell" || ctx.type === "upload_sell" ? "exchange_sell" : "exchange",
      delta,
      balance_after: ctx.applied.balance,
      ref_type: "bonus_shop",
      ref_id: ctx.item.key,
      note: ctx.item.name,
      created_at: ctx.now,
    })
    .execute();
}

async function writeFailedRecord(
  db: Db,
  ctx: {
    item: Selectable<ExchangeItemsTable>;
    userId: number;
    actorId: number | null;
    params: Record<string, unknown>;
    problem: HttpProblem;
    now: number;
  },
): Promise<void> {
  await db
    .insertInto("redemptions")
    .values({
      user_id: ctx.userId,
      item_id: Number(ctx.item.id),
      item_key: ctx.item.key,
      type: ctx.item.type,
      params_json: JSON.stringify({
        input: ctx.params,
        error: ctx.problem.code,
        message: ctx.problem.message,
      }),
      price: Number(ctx.item.price),
      status: "failed",
      actor_id: ctx.actorId,
      idempotency_key: null,
      created_at: ctx.now,
    })
    .execute();
}

function toProblem(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof UsernameChangeError) {
    const status =
      error.code === "username_taken" ||
      error.code === "rename_cooldown" ||
      error.code === "username_unchanged"
        ? 409
        : 400;
    return new HttpProblem(status, error.code, error.message);
  }
  if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
    return new HttpProblem(409, "idempotency_conflict", "请求冲突，请重试");
  }
  return new HttpProblem(500, "exchange_failed", "兑换失败");
}

export function toExchangeItemView(
  item: Selectable<ExchangeItemsTable>,
  ctx: {
    balance: number;
    user: Selectable<UsersTable>;
    used: number;
    userUsed: number;
  },
): import("@kyokkou/contracts").ExchangeItem | null {
  const type = item.type;
  if (!type || !isExchangeType(type)) return null;
  const params = parseParams(item.params_json);
  const price = effectivePrice(item);
  const remaining =
    item.inventory === null ? null : Math.max(0, Number(item.inventory) - ctx.used);
  const userRemaining =
    item.limit_per_user === null ? null : Math.max(0, Number(item.limit_per_user) - ctx.userUsed);
  let affordable = ctx.balance >= price;
  const amount = Number(item.amount ?? 0);
  if (type === "download_reduce" && Number(ctx.user.downloaded) < amount) affordable = false;
  if (type === "invite_sell" && Number(ctx.user.invite_balance) < 1) affordable = false;
  if (type === "upload_sell" && Number(ctx.user.uploaded) < amount) affordable = false;

  return {
    key: item.key,
    name: item.name,
    description: item.description,
    direction: exchangeDirectionFor(type),
    type,
    amount: item.amount === null ? null : Number(item.amount),
    params,
    requires: exchangeRequires(type),
    price,
    inventory: item.inventory === null ? null : Number(item.inventory),
    limit_per_user: item.limit_per_user === null ? null : Number(item.limit_per_user),
    remaining,
    user_remaining: userRemaining,
    affordable,
    enabled: Number(item.enabled) === 1,
    display_order: Number(item.display_order),
    min_class_rank: item.min_class_rank === null ? null : Number(item.min_class_rank),
  };
}

export function classRankOf(classRow: Selectable<ClassesTable> | null): number {
  return classRow ? Number(classRow.rank) : 0;
}
