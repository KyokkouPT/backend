import type { Kysely, Transaction } from "kysely";
import type { Db } from "../db/db.js";
import type { Database } from "../db/types.js";
import { loadSettings } from "./settings.js";
import type { Settings } from "@kyokkou/config";
import { isUsernameAvailable, normalizeUsername, validateUsername } from "./username.js";

export type UsernameChangeInput = {
  userId: number;
  newUsername: string;
  price?: number;
  itemId?: number | null;
  actorId?: number | null;
};

export type UsernameChangeResult = {
  username: string;
  refund: number;
  reverted: boolean;
  price: number;
};

export type UsernameChangeOptions = {
  /** false 时由调用方（商店兑换事务）负责扣款/退款和账本。 */
  manageBonus?: boolean;
  settings?: Settings;
};

export class UsernameChangeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Executor = Kysely<Database> | Transaction<Database>;

/**
 * 事务内改名核心。兑换服务在同一个事务中调用它，避免嵌套事务。
 * 默认管理魔力值和账本；商店传入 manageBonus=false 后自行完成。
 */
export async function applyUsernameChangeTx(
  trx: Executor,
  input: UsernameChangeInput,
  options: UsernameChangeOptions = {},
): Promise<UsernameChangeResult> {
  const settings = options.settings ?? (await loadSettings(trx as unknown as Db));
  const manageBonus = options.manageBonus ?? true;
  const checked = validateUsername(input.newUsername, { allowAdmin: false });
  if (!checked.ok) throw new UsernameChangeError(checked.code, checked.message);
  const next = checked.username;
  const now = Date.now();
  const cooldownMs = settings.shop.rename_cooldown_days * 86_400_000;
  const reserveMs = settings.shop.username_reserve_days * 86_400_000;
  const price = Math.max(0, Number(input.price ?? 0));

  const user = await trx
    .selectFrom("users")
    .select(["id", "username", "username_changed_at", "bonus"])
    .where("id", "=", input.userId)
    .executeTakeFirstOrThrow();
  if (normalizeUsername(user.username) === next) {
    throw new UsernameChangeError("username_unchanged", "新用户名与当前用户名相同");
  }
  if (!(await isUsernameAvailable(trx as unknown as Db, next, input.userId))) {
    throw new UsernameChangeError("username_taken", "用户名已被使用");
  }

  const latest = await trx
    .selectFrom("username_changes")
    .select(["old_username", "new_username", "price"])
    .where("user_id", "=", input.userId)
    .orderBy("id", "desc")
    .executeTakeFirst();
  const changedAt = user.username_changed_at === null ? null : Number(user.username_changed_at);
  const inCooldown = changedAt !== null && now - changedAt < cooldownMs;

  let refund = 0;
  let reverted = false;

  if (inCooldown) {
    if (!latest || next !== normalizeUsername(latest.old_username)) {
      throw new UsernameChangeError("rename_cooldown", "冷却期内只能改回旧用户名");
    }
    const reservation = await trx
      .selectFrom("username_reservations")
      .select(["id", "reserved_until", "released_at"])
      .where("username", "=", next)
      .where("user_id", "=", input.userId)
      .executeTakeFirst();
    if (!reservation || reservation.released_at !== null || Number(reservation.reserved_until) <= now) {
      throw new UsernameChangeError("rename_cooldown", "旧用户名保留已失效");
    }
    refund = Math.floor(Number(latest.price) * settings.shop.rename_refund_ratio);
    reverted = true;
    await trx
      .updateTable("username_reservations")
      .set({ released_at: now })
      .where("id", "=", reservation.id)
      .execute();
    await trx
      .updateTable("username_reservations")
      .set({ released_at: now })
      .where("username", "=", normalizeUsername(user.username))
      .where("user_id", "=", input.userId)
      .where("released_at", "is", null)
      .execute();
  }

  if (manageBonus && !reverted && price > 0 && Number(user.bonus) < price) {
    throw new UsernameChangeError("insufficient_bonus", "魔力值不足");
  }
  const balance = reverted ? Number(user.bonus) + refund : Number(user.bonus) - price;
  await trx
    .updateTable("users")
    .set({
      username: next,
      username_changed_at: now,
      ...(manageBonus && (refund > 0 || price > 0) ? { bonus: balance } : {}),
    })
    .where("id", "=", input.userId)
    .execute();

  if (manageBonus && !reverted && price > 0) {
    await trx
      .insertInto("bonus_ledger")
      .values({
        user_id: input.userId,
        kind: "username_change",
        delta: -price,
        balance_after: balance,
        ref_type: "username_change",
        ref_id: String(input.itemId ?? input.userId),
        note: `改名（${user.username} → ${next}）`,
        created_at: now,
      })
      .execute();
  }

  if (!reverted) {
    await trx
      .insertInto("username_reservations")
      .values({
        username: normalizeUsername(user.username),
        user_id: input.userId,
        reserved_until: now + reserveMs,
        released_at: null,
        created_at: now,
      })
      .execute();
  }

  await trx
    .insertInto("username_changes")
    .values({
      user_id: input.userId,
      old_username: user.username,
      new_username: next,
      price: reverted ? 0 : price,
      refund_amount: refund,
      item_id: input.itemId ?? null,
      actor_id: input.actorId ?? input.userId,
      created_at: now,
    })
    .execute();

  if (manageBonus && refund > 0) {
    await trx
      .insertInto("bonus_ledger")
      .values({
        user_id: input.userId,
        kind: "exchange_refund",
        delta: refund,
        balance_after: balance,
        ref_type: "username_change",
        ref_id: String(input.itemId ?? input.userId),
        note: `用户名回退退款（${user.username} → ${next}）`,
        created_at: now,
      })
      .execute();
  }

  await trx
    .insertInto("audit_logs")
    .values({
      actor_id: input.actorId ?? input.userId,
      action: "user.username_change",
      target_type: "user",
      target_id: String(input.userId),
      detail_json: JSON.stringify({
        from: user.username,
        to: next,
        price: reverted ? 0 : price,
        refund,
        reverted,
      }),
      ip: null,
      created_at: now,
    })
    .execute();

  return { username: next, refund, reverted, price: reverted ? 0 : price };
}

/** 自助改名 wrapper（当前没有公开入口，供测试/后续使用）。 */
export async function applyUsernameChange(
  db: Db,
  input: UsernameChangeInput,
): Promise<UsernameChangeResult> {
  const settings = await loadSettings(db);
  return db.transaction().execute((trx) =>
    applyUsernameChangeTx(trx, input, { manageBonus: true, settings }),
  );
}
