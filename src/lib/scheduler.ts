import cronParser from "cron-parser";
import type { Settings } from "@kyokkou/config";
import type { Db } from "../db/db.js";
import { loadSettings } from "./settings.js";
import { runClassRecalc } from "./class-recalc.js";
import { runBonusSettlement } from "./bonus.js";

export const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;

type Logger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

type CronTiming = {
  next: number;
  intervalMs: number;
};

export type CronCheck =
  | { ok: true; next: number; intervalMs: number }
  | { ok: false; error: string };

export function validateCronExpression(expression: string, from = Date.now()): CronCheck {
  try {
    const interval = cronParser.parseExpression(expression, { currentDate: new Date(from) });
    const first = interval.next().getTime();
    const second = interval.next().getTime();
    if (second - first < MIN_CRON_INTERVAL_MS) {
      return { ok: false, error: "cron 间隔不能小于 5 分钟" };
    }
    return { ok: true, next: first, intervalMs: second - first };
  } catch {
    return { ok: false, error: "cron 表达式无效" };
  }
}

export function nextRunAt(expression: string, from = Date.now()): number | null {
  const checked = validateCronExpression(expression, from);
  return checked.ok ? checked.next : null;
}

type JobKey = "bonus" | "class";

type JobState = {
  key: JobKey;
  priority: number;
  nextAt: number;
  intervalMs: number;
  running: boolean;
};

type SchedulerState = {
  db: Db | null;
  logger: Logger | null;
  timer: NodeJS.Timeout | null;
  jobs: JobState[];
  tickRunning: boolean;
  generation: number;
  instanceId: string;
};

const state: SchedulerState = {
  db: null,
  logger: null,
  timer: null,
  jobs: [],
  tickRunning: false,
  generation: 0,
  instanceId: `unknown:${String(process.pid)}`,
};

async function acquireLease(
  db: Db,
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, ttlMs);
  const updated = await db
    .updateTable("job_leases")
    .set({ owner, expires_at: expiresAt, updated_at: now })
    .where("key", "=", key)
    .where((eb) => eb.or([eb("owner", "=", owner), eb("expires_at", "<", now)]))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) > 0) return true;
  try {
    await db
      .insertInto("job_leases")
      .values({ key, owner, expires_at: expiresAt, updated_at: now })
      .execute();
    return true;
  } catch {
    return false;
  }
}

async function releaseLease(db: Db, key: string, owner: string): Promise<void> {
  await db.deleteFrom("job_leases").where("key", "=", key).where("owner", "=", owner).execute();
}

function jobEnabled(key: JobKey, settings: Settings): string | null {
  if (key === "class") {
    return settings.classes.recalc_enabled ? settings.classes.recalc_cron : null;
  }
  return settings.bonus.cron;
}

function buildJobs(settings: Settings, from: number): JobState[] {
  const jobs: JobState[] = [];
  const definitions: { key: JobKey; priority: number }[] = [
    { key: "bonus", priority: 1 },
    { key: "class", priority: 2 },
  ];
  for (const definition of definitions) {
    const expression = jobEnabled(definition.key, settings);
    if (!expression) continue;
    const checked = validateCronExpression(expression, from);
    if (!checked.ok) {
      state.logger?.error(
        { job: definition.key, cron: expression, err: checked.error },
        "scheduler cron invalid, job disabled",
      );
      continue;
    }
    jobs.push({
      key: definition.key,
      priority: definition.priority,
      nextAt: checked.next,
      intervalMs: checked.intervalMs,
      running: false,
    });
  }
  return jobs.sort((a, b) => a.priority - b.priority);
}

async function runJob(job: JobState): Promise<void> {
  const { db, logger } = state;
  if (!db) return;
  const intervalMs = job.intervalMs;
  try {
    if (job.key === "bonus") {
      const result = await runBonusSettlement(db, { intervalMs, triggeredBy: "cron" });
      logger?.info({ ...result, intervalMs }, "bonus settlement finished");
    } else {
      const result = await runClassRecalc(db, { triggeredBy: "cron", actorId: null });
      logger?.info(result, "class recalc finished");
    }
  } catch (error) {
    logger?.error({ err: error, job: job.key }, "scheduled job failed");
  }
}

function scheduleNext(generation: number): void {
  if (generation !== state.generation || state.tickRunning) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const next = Math.min(...state.jobs.map((job) => job.nextAt));
  if (!Number.isFinite(next)) return;
  const delay = Math.max(1000, next - Date.now());
  const safeDelay = Math.min(delay, 2 ** 31 - 1);
  state.timer = setTimeout(() => {
    void tick(generation);
  }, safeDelay);
  state.timer.unref?.();
}

async function tick(generation: number): Promise<void> {
  if (generation !== state.generation || state.tickRunning) return;
  state.tickRunning = true;
  try {
    const now = Date.now();
    const due = state.jobs
      .filter((job) => job.nextAt <= now && !job.running)
      .sort((a, b) => a.priority - b.priority);
    for (const job of due) {
      const db = state.db;
      const leaseKey = `scheduler:${job.key}`;
      const leaseTtl = Math.max(15 * 60 * 1000, job.intervalMs * 2);
      if (!db || !(await acquireLease(db, leaseKey, state.instanceId, leaseTtl))) {
        state.logger?.info({ job: job.key }, "scheduler job skipped (lease held)");
        const skipped = validateCronExpression(cronForJob(job.key), Date.now());
        job.nextAt = skipped.ok ? skipped.next : Number.POSITIVE_INFINITY;
        if (skipped.ok) job.intervalMs = skipped.intervalMs;
        continue;
      }
      job.running = true;
      const renew = setInterval(() => {
        void acquireLease(db, leaseKey, state.instanceId, leaseTtl).catch(() => undefined);
      }, Math.max(60_000, Math.floor(leaseTtl / 2)));
      renew.unref?.();
      try {
        await runJob(job);
      } finally {
        clearInterval(renew);
        job.running = false;
        await releaseLease(db, leaseKey, state.instanceId);
      }
      if (generation !== state.generation) return;
      const checked = validateCronExpression(cronForJob(job.key), Date.now());
      if (checked.ok) {
        job.nextAt = checked.next;
        job.intervalMs = checked.intervalMs;
      } else {
        job.nextAt = Number.POSITIVE_INFINITY;
      }
    }
  } finally {
    state.tickRunning = false;
    // 设置可能在任务执行期间被热重载；用最新 generation 重新排程。
    scheduleNext(state.generation);
  }
}

function cronForJob(key: JobKey): string {
  // tick 期间设置不会切换（reload 会递增 generation）；从当前设置读取。
  const settings = settingsCache;
  if (!settings) return "* * * * *";
  return key === "bonus" ? settings.bonus.cron : settings.classes.recalc_cron;
}

let settingsCache: Settings | null = null;

export async function acquireJobLease(
  db: Db,
  key: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  return acquireLease(db, key, owner, ttlMs);
}

export async function releaseJobLease(db: Db, key: string, owner: string): Promise<void> {
  await releaseLease(db, key, owner);
}

export async function reloadSchedulers(db: Db | null = state.db): Promise<{ bonus: number | null; class: number | null }> {
  if (!db) return { bonus: null, class: null };
  state.db = db;
  state.generation += 1;
  const generation = state.generation;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  let settings: Settings;
  try {
    settings = await loadSettings(db);
  } catch (error) {
    state.logger?.error({ err: error }, "scheduler settings load failed");
    state.jobs = [];
    settingsCache = null;
    return { bonus: null, class: null };
  }
  settingsCache = settings;
  state.jobs = buildJobs(settings, Date.now());
  if (!state.tickRunning) scheduleNext(generation);
  const bonus = state.jobs.find((job) => job.key === "bonus")?.nextAt ?? null;
  const classJob = state.jobs.find((job) => job.key === "class")?.nextAt ?? null;
  return { bonus, class: classJob };
}

export function initSchedulers(db: Db, logger: Logger, instanceId?: string): void {
  state.db = db;
  state.logger = logger;
  if (instanceId) state.instanceId = instanceId;
  void reloadSchedulers(db);
}

export function stopSchedulers(): void {
  state.generation += 1;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}
