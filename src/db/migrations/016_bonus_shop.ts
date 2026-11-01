import { sql } from "kysely";
import type { ColumnDefinitionBuilder } from "kysely";
import type { Migration } from "./types.js";

/**
 * 016_bonus_shop · 统一魔力值商店类型、失败记录、H&R 机会与头衔。
 */
export const migration016: Migration = {
  version: 16,
  name: "bonus_shop",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";
    const now = Date.now();

    const addColumn = async (
      table: string,
      column: string,
      type: string,
      build?: (col: ColumnDefinitionBuilder) => ColumnDefinitionBuilder,
    ): Promise<void> => {
      try {
        await db.schema
          .alterTable(table)
          .addColumn(column, type as never, build)
          .execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
      }
    };

    await addColumn("exchange_items", "direction", "varchar(8)", (col) =>
      col.notNull().defaultTo("buy"),
    );
    await addColumn("exchange_items", "type", "varchar(32)");
    await addColumn("exchange_items", "amount", "bigint");
    await addColumn("exchange_items", "params_json", "text");
    await addColumn("exchange_items", "min_class_rank", "integer");
    await addColumn("redemptions", "type", "varchar(32)");
    await addColumn("redemptions", "params_json", "text");
    await addColumn("redemptions", "actor_id", "bigint");
    await addColumn("redemptions", "item_key", "varchar(64)");
    await addColumn("users", "custom_title", "varchar(64)");

    await db.updateTable("exchange_items").set({ direction: "buy" }).execute();

    const items = await db
      .selectFrom("exchange_items")
      .select(["id", "key", "payload_json", "type"])
      .execute();
    for (const item of items) {
      if (item.type) continue;
      let payload: { type?: unknown; amount?: unknown } = {};
      try {
        payload = JSON.parse(item.payload_json) as { type?: unknown; amount?: unknown };
      } catch {
        continue;
      }
      let type: string | null = null;
      if (payload.type === "upload") type = "upload_add";
      else if (payload.type === "download_discount") type = "download_reduce";
      else if (payload.type === "invite") type = "invite_add";
      if (!type) continue;
      await db
        .updateTable("exchange_items")
        .set({
          type,
          amount:
            type === "invite_add"
              ? 1
              : typeof payload.amount === "number" && Number.isFinite(payload.amount)
                ? Math.floor(payload.amount)
                : null,
        })
        .where("id", "=", item.id)
        .execute();
    }

    const itemRows = await db
      .selectFrom("exchange_items")
      .select(["id", "key", "type"])
      .execute();
    const byId = new Map(itemRows.map((row) => [Number(row.id), row]));
    const redemptions = await db
      .selectFrom("redemptions")
      .select(["id", "item_id", "user_id", "type"])
      .execute();
    for (const redemption of redemptions) {
      const item = byId.get(Number(redemption.item_id));
      if (!item) continue;
      await db
        .updateTable("redemptions")
        .set({
          type: item.type ?? redemption.type ?? null,
          item_key: item.key,
          actor_id: Number(redemption.user_id),
        })
        .where("id", "=", redemption.id)
        .execute();
    }

    try {
      if (dialect === "mysql" || dialect === "mariadb") {
        await sql`drop index ${sql.ref("redemptions_idempotency_uq")} on ${sql.table("redemptions")}`.execute(db);
      } else {
        await db.schema.dropIndex("redemptions_idempotency_uq").execute();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such index|doesn't exist|unknown key|not exist|check that column/i.test(message)) {
        throw error;
      }
    }
    try {
      await db.schema
        .createIndex("redemptions_user_idempotency_uq")
        .on("redemptions")
        .columns(["user_id", "idempotency_key"])
        .unique()
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate|already exists|Duplicate key/i.test(message)) throw error;
    }

    await db.schema
      .createIndex("redemptions_item_status_idx")
      .on("redemptions")
      .columns(["item_id", "status"])
      .execute();

    await db.schema
      .createTable("user_credits")
      .ifNotExists()
      .addColumn("id", idType, (col) =>
        dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement(),
      )
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("kind", "varchar(32)", (col) => col.notNull())
      .addColumn("quantity", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("expires_at", "bigint")
      .addColumn("source_redemption_id", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("user_credits_user_kind_expiry_idx")
      .on("user_credits")
      .columns(["user_id", "kind", "expires_at"])
      .execute();

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
      if (!permissions.includes("staff.bonus_shop")) {
        await db
          .updateTable("classes")
          .set({
            permissions_json: JSON.stringify([...permissions, "staff.bonus_shop"]),
            updated_at: now,
          })
          .where("id", "=", owner.id)
          .execute();
      }
    }

    await db
      .insertInto("audit_logs")
      .values({
        actor_id: null,
        action: "bonus_shop.migrate",
        target_type: "system",
        target_id: "bonus_shop",
        detail_json: JSON.stringify({ version: 16 }),
        ip: null,
        created_at: now,
      })
      .execute();
  },
};
