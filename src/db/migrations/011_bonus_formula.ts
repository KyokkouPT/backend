import { sql } from "kysely";
import type { Migration } from "./types.js";

/**
 * 011_bonus_formula · 浮点魔力值、零魔种子、捐赠者权限节点。
 *
 * SQLite 使用 NUMERIC affinity，bigint 列可以原样存浮点，因此无需 ALTER；
 * MySQL/MariaDB 与 PostgreSQL 需要显式切换为 double。
 */
export const migration011: Migration = {
  version: 11,
  name: "bonus_formula",
  async up({ db, dialect }) {
    const changeToDouble = async (table: string, column: string): Promise<void> => {
      if (dialect === "sqlite") return;
      const type = dialect === "postgres" ? "double precision" : sql`double`;
      try {
        await db.schema
          .alterTable(table)
          .alterColumn(column, (ac) => ac.setDataType(type))
          .execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // MySQL DDL 非事务；重试时已经改过则跳过。
        if (!/duplicate|already|unknown column|modify/i.test(message)) throw error;
      }
    };

    await changeToDouble("users", "bonus");
    await changeToDouble("bonus_ledger", "delta");
    await changeToDouble("bonus_ledger", "balance_after");
    await changeToDouble("exchange_items", "price");
    await changeToDouble("redemptions", "price");

    try {
      await db.schema
        .alterTable("torrents")
        .addColumn("zero_bonus", "integer", (col) => col.notNull().defaultTo(0))
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
    }

    // owner 默认拥有 user.donor；其他等级由站长自行勾选。
    const owner = await db
      .selectFrom("classes")
      .select(["id", "permissions_json"])
      .where("slug", "=", "owner")
      .executeTakeFirst();
    if (owner) {
      let permissions: string[] = [];
      try {
        const parsed: unknown = JSON.parse(owner.permissions_json);
        if (Array.isArray(parsed)) permissions = parsed.filter((item): item is string => typeof item === "string");
      } catch {
        permissions = [];
      }
      if (!permissions.includes("user.donor")) {
        await db
          .updateTable("classes")
          .set({ permissions_json: JSON.stringify([...permissions, "user.donor"]), updated_at: Date.now() })
          .where("id", "=", owner.id)
          .execute();
      }
    }
  },
};
