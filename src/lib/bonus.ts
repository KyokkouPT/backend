import { DEFAULT_BONUS_FORMULA } from "@kyokkou/config";
import type { Selectable } from "kysely";
import type { Db } from "../db/db.js";
import type { UsersTable } from "../db/types.js";
import { loadSettings } from "./settings.js";
import { evaluateFormula, FormulaError, type FormulaEvaluation } from "./bonus-formula.js";
import { loadBonusContexts, type BonusUserContext } from "./bonus-context.js";

type UserRow = Selectable<UsersTable>;

export type BonusSettlementResult = {
  users: number;
  credited: number;
  skipped: number;
  failed: number;
  formula_fallback: boolean;
};

export type BonusRate = {
  rate: number;
  frozen: boolean;
  evaluation: FormulaEvaluation | null;
};

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
    .where("t.status", "=", "approved")
    .where("t.deleted_at", "is", null)
    .execute();

  return {
    count: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.size), 0),
  };
}

async function formulaSource(db: Db): Promise<{ source: string; fallback: boolean }> {
  const settings = await loadSettings(db);
  const source = settings.bonus.formula.trim();
  if (source.length === 0) return { source: DEFAULT_BONUS_FORMULA, fallback: true };
  return { source, fallback: false };
}

function userFrozen(context: BonusUserContext, now: number): boolean {
  return context.frozenUntil !== null && context.frozenUntil > now;
}

/** 预览/个人页用：计算某用户当前每小时产出，不写库。 */
export async function evaluateBonusRate(db: Db, user: UserRow, now = Date.now()): Promise<BonusRate> {
  const { source, fallback } = await formulaSource(db);
  const contextMap = await loadBonusContexts(db, [Number(user.id)], now);
  const context = contextMap.get(Number(user.id));
  if (!context) {
    return { rate: 0, frozen: false, evaluation: null };
  }
  context.frozenUntil =
    user.bonus_frozen_until === null ? null : Number(user.bonus_frozen_until);
  if (userFrozen(context, now)) {
    return { rate: 0, frozen: true, evaluation: null };
  }
  try {
    const evaluation = evaluateFormula(fallback ? DEFAULT_BONUS_FORMULA : source, context);
    return { rate: evaluation.result, frozen: false, evaluation };
  } catch {
    return { rate: 0, frozen: false, evaluation: null };
  }
}

/**
 * 按一次 cron 的标称间隔结算所有 active 用户。
 * 不读 last_bonus_at、不补发；公式异常的用户本次按 0。
 */
export async function runBonusSettlement(
  db: Db,
  options: { intervalMs: number; triggeredBy?: "cron" | "manual" },
): Promise<BonusSettlementResult> {
  const intervalMs = Math.max(0, options.intervalMs);
  const hours = intervalMs / 3_600_000;
  const { source, fallback } = await formulaSource(db);
  let formula = source;
  let formulaFallback = fallback;
  try {
    // 编译一次，后续每个用户复用缓存。
    evaluateFormula(formula, {
      user: {
        seeders: 0,
        totalGb: 0,
        totalBytes: 0,
        avgSizeGb: 0,
        uploaded: 0,
        downloaded: 0,
        ratio: 0,
        ageDays: 0,
        bonus: 0,
        isDonor: false,
        hour: 0,
        dayOfWeek: 0,
        userId: 0,
      },
      torrents: [],
    });
  } catch (error) {
    if (error instanceof FormulaError) {
      formula = DEFAULT_BONUS_FORMULA;
      formulaFallback = true;
    } else {
      throw error;
    }
  }

  const now = Date.now();
  let lastId = 0;
  let users = 0;
  let credited = 0;
  let skipped = 0;
  let failed = 0;
  const batchSize = 500;

  for (;;) {
    const ids = await db
      .selectFrom("users")
      .select("id")
      .where("status", "=", "active")
      .where("id", ">", lastId)
      .orderBy("id", "asc")
      .limit(batchSize)
      .execute();
    if (ids.length === 0) break;
    const idList = ids.map((row) => Number(row.id));
    lastId = idList[idList.length - 1] ?? lastId;
    users += idList.length;

    const contexts = await loadBonusContexts(db, idList, now);
    const ledgerRows: {
      user_id: number;
      kind: string;
      delta: number;
      balance_after: number;
      ref_type: string | null;
      ref_id: string | null;
      note: string | null;
      created_at: number;
    }[] = [];
    const updates: { id: number; delta: number; balance: number }[] = [];

    for (const id of idList) {
      const context = contexts.get(id);
      if (!context) {
        skipped += 1;
        continue;
      }
      if (userFrozen(context, now)) {
        skipped += 1;
        continue;
      }
      try {
        const evaluation = evaluateFormula(formula, context);
        const delta = evaluation.result * hours;
        if (!Number.isFinite(delta)) {
          failed += 1;
          continue;
        }
        if (delta === 0) {
          skipped += 1;
          continue;
        }
        const balanceAfter = Number(context.user.bonus) + delta;
        updates.push({ id, delta, balance: balanceAfter });
        ledgerRows.push({
          user_id: id,
          kind: "seeding",
          delta,
          balance_after: balanceAfter,
          ref_type: "cron",
          ref_id: String(Math.floor(now / 1000)),
          note: `做种产出（${hours.toFixed(4)} 小时）`,
          created_at: now,
        });
      } catch {
        failed += 1;
      }
    }

    if (updates.length > 0) {
      await db.transaction().execute(async (trx) => {
        for (const update of updates) {
          await trx
            .updateTable("users")
            .set((eb) => ({ bonus: eb("bonus", "+", update.delta), last_bonus_at: now }))
            .where("id", "=", update.id)
            .execute();
        }
        await trx.insertInto("bonus_ledger").values(ledgerRows).execute();
      });
      credited += updates.length;
    }
  }

  return {
    users,
    credited,
    skipped,
    failed,
    formula_fallback: formulaFallback,
  };
}
