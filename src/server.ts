import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/db.js";
import { currentSchemaVersion, runMigrations } from "./db/migrate.js";

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
}

void main();
