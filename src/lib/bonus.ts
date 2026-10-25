import type { Selectable } from "kysely";
import type { Db } from "../db/db.js";
import type { UsersTable } from "../db/types.js";

type UserRow = Selectable<UsersTable>;

const HOUR_MS = 3_600_000;

/**
 * 每小时产出：基础做种数 + 体积加权，封顶避免大种子垄断。
 * 这是可配置公式的 v1 实现，后续可放进 site_settings.economy。
 */
export function yieldPerHourBase(seedingCount: number, totalBytes: number): number {
  const totalGb = totalBytes / 1024 ** 3;
  const value = seedingCount * 0.5 + Math.min(totalGb * 0.02, 20);
  return Math.round(value * 100) / 100;
}

export async function seedingStats(
  db: Db,
  userId: number,
): Promise<{ count: number; totalBytes: number }> {
  const rows = await db
    .selectFrom("snatches as sn")
    .innerJoin("torrents as t", "t.id", "sn.torrent_id")
    .select(["t.size as size"])
    .where("sn.user_id", "=", userId)
    .where("sn.status", "=", "seeding")
    .execute();

  return {
    count: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.size), 0),
  };
}

/**
 * 结算自 last_bonus_at 以来的魔力值。按需调用（/me/bonus），不依赖后台定时器。
 * 冻结期间产出为 0，但仍推进 last_bonus_at，避免解冻后补发。
 */
export async function settleBonus(
  db: Db,
  user: UserRow,
): Promise<{ balance: number; yieldPerHour: number; frozenUntil: number | null }> {
  const now = Date.now();
  const frozenUntil = user.bonus_frozen_until === null ? null : Number(user.bonus_frozen_until);
  const frozen = frozenUntil !== null && frozenUntil > now;

  const stats = await seedingStats(db, Number(user.id));
  const rate = frozen ? 0 : yieldPerHourBase(stats.count, stats.totalBytes);
  const last = user.last_bonus_at === null ? now : Number(user.last_bonus_at);
  const hours = Math.max(0, (now - last) / HOUR_MS);
  const delta = frozen ? 0 : Math.floor(rate * hours);

  if (user.last_bonus_at === null || delta > 0) {
    const balance = Number(user.bonus) + delta;
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("users")
        .set({ bonus: balance, last_bonus_at: now })
        .where("id", "=", user.id)
        .execute();

      if (delta > 0) {
        await trx
          .insertInto("bonus_ledger")
          .values({
            user_id: Number(user.id),
            kind: "seeding",
            delta,
            balance_after: balance,
            ref_type: null,
            ref_id: null,
            note: `做种产出（${hours.toFixed(2)} 小时）`,
            created_at: now,
          })
          .execute();
      }
    });

    return { balance, yieldPerHour: rate, frozenUntil };
  }

  return { balance: Number(user.bonus), yieldPerHour: rate, frozenUntil };
}
