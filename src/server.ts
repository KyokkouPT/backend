import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/db.js";
import { currentSchemaVersion, runMigrations } from "./db/migrate.js";
import { settleHnr } from "./lib/hnr.js";
import { initClassScheduler, stopClassScheduler } from "./lib/class-scheduler.js";
import { prunePeers } from "./tracker/registry.js";

const PEER_TTL_MS = 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });

  try {
    const applied = await runMigrations(db, config.databaseDriver);
    if (applied.length > 0) {
      console.log(
        `applied ${String(applied.length)} migration(s), schema version ${String(await currentSchemaVersion(db))}`,
      );
    }
  } catch (error) {
    console.error("migration failed:", error instanceof Error ? error.message : error);
    await db.destroy();
    process.exit(1);
  }

  const app = buildApp({ db, config }, { logger: { level: config.logLevel } });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    stopClassScheduler();
    await app.close();
    await db.destroy();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      {
        host: config.host,
        port: config.port,
        env: config.nodeEnv,
        driver: config.databaseDriver,
      },
      "kyokkoupt-backend listening",
    );
  } catch (error) {
    app.log.error(error, "failed to start");
    await db.destroy();
    process.exit(1);
  }

  // 维护任务：H&R 义务结算 + 过期 peer 清理。unref 不阻塞退出。
  const hnrTimer = setInterval(() => {
    void settleHnr(db)
      .then((changed) => {
        if (changed > 0) app.log.info({ changed }, "hnr obligations settled");
      })
      .catch((error: unknown) => app.log.error(error, "hnr settlement failed"));
  }, MAINTENANCE_INTERVAL_MS);
  hnrTimer.unref();

  const peerTimer = setInterval(() => {
    const removed = prunePeers(PEER_TTL_MS);
    if (removed > 0) app.log.debug({ removed }, "pruned stale peers");
  }, MAINTENANCE_INTERVAL_MS);
  peerTimer.unref();

  // 等级重算调度：cron 来自站点设置，可热重载。
  initClassScheduler(db, app.log);
}

void main();
