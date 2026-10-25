import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../config.js";
import { createDb } from "./db.js";
import { currentSchemaVersion, runMigrations } from "./migrate.js";

const TABLES = [
  "instance_meta",
  "site_settings",
  "users",
  "sessions",
  "sections",
  "categories",
  "torrents",
  "torrent_files",
  "torrent_field_values",
  "tags",
  "torrent_tags",
  "promo_events",
  "announcements",
  "snatches",
  "audit_logs",
] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });

  try {
    await runMigrations(db, config.databaseDriver);
    console.log(`driver   : ${config.databaseDriver}`);
    console.log(`database : ${config.databaseUrl}`);
    console.log(`schema   : version ${await currentSchemaVersion(db)}`);

    for (const table of TABLES) {
      const row = await db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirst();
      console.log(`  ${table.padEnd(22, ".")} ${Number(row?.count ?? 0)}`);
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
