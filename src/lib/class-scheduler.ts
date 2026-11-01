import cronParser from "cron-parser";
import type { Db } from "../db/db.js";
import { loadSettings } from "./settings.js";
import { runClassRecalc } from "./class-recalc.js";

/** cron 最小间隔：5 分钟（防止每 1 分钟重算带来压力）。 */
export const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;

type CronCheck =
  | { ok: true; next: number }
  | { ok: false; error: string };

export function validateCronExpression(expression: string, from = Date.now()): CronCheck {
  try {
    const interval = cronParser.parseExpression(expression, { currentDate: new Date(from) });
    const first = interval.next().getTime();
    const second = interval.next().getTime();
    if (second - first < MIN_CRON_INTERVAL_MS) {
      return { ok: false, error: "cron 间隔不能小于 5 分钟" };
    }
    return { ok: true, next: first };
  } catch {
    return { ok: false, error: "cron 表达式无效" };
  }
}

export function nextRunAt(expression: string, from = Date.now()): number | null {
  const checked = validateCronExpression(expression, from);
  return checked.ok ? checked.next : null;
}

type Logger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

type SchedulerState = {
  db: Db | null;
  logger: Logger | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
};

const state: SchedulerState = { db: null, logger: null, timer: null, running: false };

async function tick(): Promise<void> {
  const { db, logger } = state;
  if (!db) return;
  if (state.running) return;
  state.running = true;
  try {
    const result = await runClassRecalc(db, { triggeredBy: "cron", actorId: null });
    logger?.info(result, "class recalc finished");
  } catch (error) {
    logger?.error({ err: error }, "class recalc failed");
  } finally {
    state.running = false;
    await reloadClassScheduler(db);
  }
}

export async function reloadClassScheduler(db: Db | null = state.db): Promise<number | null> {
  if (!db) return null;
  state.db = db;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  let settings;
  try {
    settings = await loadSettings(db);
  } catch {
    return null;
  }

  if (!settings.classes.recalc_enabled) return null;
  const checked = validateCronExpression(settings.classes.recalc_cron);
  if (!checked.ok) return null;

  const delay = Math.max(1000, checked.next - Date.now());
  // setTimeout 上限约 24.8 天，cron 通常更短；超长时截断，下次触发重新计算。
  const safeDelay = Math.min(delay, 2 ** 31 - 1);
  state.timer = setTimeout(() => {
    void tick();
  }, safeDelay);
  state.timer.unref?.();
  return checked.next;
}

export function initClassScheduler(db: Db, logger: Logger): void {
  state.db = db;
  state.logger = logger;
  void reloadClassScheduler(db);
}

export function stopClassScheduler(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}
