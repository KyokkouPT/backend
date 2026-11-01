import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../config.js";
import { createDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { seedDatabase } from "./seed.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });

  try {
    await runMigrations(db, config.databaseDriver);
    const summary = await seedDatabase(db, { password: config.seedPassword });
    console.log("seed complete:", summary);
    console.log("开发账号：lightbringer / root（admin）、axue（user）");
    console.log(`密码来自 SEED_PASSWORD（当前长度 ${config.seedPassword.length}）`);
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
