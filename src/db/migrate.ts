import type { Db } from "./db.js";
import { migrations } from "./migrations/index.js";
import type { Migration } from "./migrations/types.js";
import type { DatabaseDriver } from "../config.js";

export type AppliedMigration = { version: number; name: string };

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.schema
    .createTable("schema_migrations")
    .ifNotExists()
    .addColumn("version", "integer", (col) => col.primaryKey())
    .addColumn("name", "varchar(64)", (col) => col.notNull())
    .addColumn("applied_at", "bigint", (col) => col.notNull())
    .execute();
}

/**
 * 按版本顺序执行未应用的迁移，并记录到 schema_migrations。
 *
 * - SQLite / PostgreSQL：整个迁移在一个事务里；
 * - MySQL / MariaDB：DDL 会隐式提交，失败时明确抛出（不静默），
 *   重试前需要人工检查已部分应用的 DDL。
 */
export async function runMigrations(
  db: Db,
  dialect: DatabaseDriver,
  list: Migration[] = migrations,
): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(db);

  const appliedRows = await db.selectFrom("schema_migrations").select("version").execute();
  const applied = new Set(appliedRows.map((row) => row.version));
  const pending = [...list].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));

  const ran: AppliedMigration[] = [];

  for (const migration of pending) {
    try {
      await db.transaction().execute(async (trx) => {
        await migration.up({ db: trx, dialect });
        await trx
          .insertInto("schema_migrations")
          .values({
            version: migration.version,
            name: migration.name,
            applied_at: Date.now(),
          })
          .execute();
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `migration ${String(migration.version).padStart(3, "0")}_${migration.name} failed on ${dialect}: ${reason}`,
      );
    }
    ran.push({ version: migration.version, name: migration.name });
  }

  return ran;
}

export async function currentSchemaVersion(db: Db): Promise<number> {
  const rows = await db.selectFrom("schema_migrations").select("version").execute();
  return rows.reduce((max, row) => Math.max(max, row.version), 0);
}
