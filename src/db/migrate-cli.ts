import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../config.js";
import { createDb } from "./db.js";
import { currentSchemaVersion, runMigrations } from "./migrate.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });

  try {
    const applied = await runMigrations(db, config.databaseDriver);
    if (applied.length === 0) {
      console.log(`schema up to date (version ${await currentSchemaVersion(db)})`);
    } else {
      for (const migration of applied) {
        console.log(`applied ${String(migration.version).padStart(3, "0")}_${migration.name}`);
      }
      console.log(`schema now at version ${await currentSchemaVersion(db)}`);
    }
  } finally {
    await db.destroy();
  }
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isMain) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(error);
    process.exit(1);
  });
}
