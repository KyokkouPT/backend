import { sql } from "kysely";
import type { Migration } from "./types.js";
import {
  USER_EDIT_BASIC_PERMISSIONS,
  USER_EDIT_SENSITIVE_PERMISSIONS,
} from "../../lib/class-defaults.js";
import { migrationUsername, USERNAME_PATTERN } from "../../lib/username.js";

/**
 * 014_username_rules · 用户名小写/ASCII 规则、改名历史与颗粒化 user_edit 权限。
 */
export const migration014: Migration = {
  version: 14,
  name: "username_rules",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";
    const priceType = dialect === "postgres" ? "double precision" : sql`double`;

    try {
      await db.schema.alterTable("users").addColumn("username_changed_at", "bigint").execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
    }

    await db.schema
      .createTable("username_reservations")
      .ifNotExists()
      .addColumn("id", idType, (col) =>
        dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement(),
      )
      .addColumn("username", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("reserved_until", "bigint", (col) => col.notNull())
      .addColumn("released_at", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("username_changes")
      .ifNotExists()
      .addColumn("id", idType, (col) =>
        dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement(),
      )
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("old_username", "varchar(64)", (col) => col.notNull())
      .addColumn("new_username", "varchar(64)", (col) => col.notNull())
      .addColumn("price", priceType, (col) => col.notNull().defaultTo(0))
      .addColumn("refund_amount", priceType, (col) => col.notNull().defaultTo(0))
      .addColumn("item_id", "bigint")
      .addColumn("actor_id", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("username_changes_user_created_idx")
      .on("username_changes")
      .columns(["user_id", "created_at"])
      .execute();

    const users = await db
      .selectFrom("users")
      .select(["id", "username"])
      .orderBy("id", "asc")
      .execute();

    // 统计当前每个小写名的占用数，处理 Alice/alice 这类冲突。
    const counts = new Map<string, number>();
    for (const user of users) {
      const lower = user.username.trim().toLowerCase();
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
    }

    const taken = new Set<string>(counts.keys());
    const targets = new Map<number, { old: string; next: string }>();
    for (const user of users) {
      const id = Number(user.id);
      const old = user.username;
      const oldLower = old.trim().toLowerCase();
      const remaining = (counts.get(oldLower) ?? 1) - 1;
      if (remaining <= 0) {
        counts.delete(oldLower);
        taken.delete(oldLower);
      } else {
        counts.set(oldLower, remaining);
      }

      const next = migrationUsername(old, id, taken);
      taken.add(next);
      counts.set(next, (counts.get(next) ?? 0) + 1);
      if (next !== old) targets.set(id, { old, next });
    }

    const now = Date.now();
    for (const [id, change] of targets) {
      await db
        .updateTable("users")
        .set({ username: change.next })
        .where("id", "=", id)
        .execute();
      await db
        .insertInto("notifications")
        .values({
          user_id: id,
          kind: "account",
          title: "用户名已调整",
          body: `你的用户名已从 ${change.old} 调整为 ${change.next}`,
          link_url: "/me",
          read_at: null,
          created_at: now,
        })
        .execute();
    }

    if (targets.size > 0) {
      await db
        .insertInto("audit_logs")
        .values({
          actor_id: null,
          action: "user.username_migrate",
          target_type: "system",
          target_id: "username_rules",
          detail_json: JSON.stringify({
            changed: [...targets.values()].map((item) => ({
              from: item.old,
              to: item.next,
            })),
          }),
          ip: null,
          created_at: now,
        })
        .execute();
    }

    // 权限迁移：移除父节点，旧 class/status 并入 user_edit.*，补齐默认子权限。
    const basic = new Set<string>(USER_EDIT_BASIC_PERMISSIONS);
    const sensitive = new Set<string>(USER_EDIT_SENSITIVE_PERMISSIONS);
    const classes = await db
      .selectFrom("classes")
      .select(["id", "slug", "permissions_json"])
      .execute();

    for (const row of classes) {
      let permissions: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.permissions_json);
        if (Array.isArray(parsed)) {
          permissions = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        permissions = [];
      }

      const next = new Set<string>();
      for (const permission of permissions) {
        if (permission === "staff.user_edit") continue;
        if (permission === "staff.user_class") {
          next.add("staff.user_edit.class");
          continue;
        }
        if (permission === "staff.user_status") {
          next.add("staff.user_edit.status");
          continue;
        }
        next.add(permission);
      }

      if (row.slug === "staff") {
        for (const permission of basic) next.add(permission);
      }
      if (row.slug === "owner") {
        for (const permission of basic) next.add(permission);
        for (const permission of sensitive) next.add(permission);
      }

      const list = [...next].sort();
      if (JSON.stringify(list) !== JSON.stringify([...permissions].sort())) {
        await db
          .updateTable("classes")
          .set({ permissions_json: JSON.stringify(list), updated_at: now })
          .where("id", "=", row.id)
          .execute();
      }
    }

    // 个人权限覆盖同样不能保留父节点/旧节点。
    const overrides = await db
      .selectFrom("user_permission_overrides")
      .select(["id", "user_id", "permission"])
      .execute();
    for (const override of overrides) {
      let mapped: string | null = override.permission;
      if (mapped === "staff.user_edit") mapped = null;
      if (mapped === "staff.user_class") mapped = "staff.user_edit.class";
      if (mapped === "staff.user_status") mapped = "staff.user_edit.status";
      if (mapped === override.permission) continue;
      if (mapped === null) {
        await db.deleteFrom("user_permission_overrides").where("id", "=", override.id).execute();
        continue;
      }
      const exists = await db
        .selectFrom("user_permission_overrides")
        .select("id")
        .where("user_id", "=", override.user_id)
        .where("permission", "=", mapped)
        .executeTakeFirst();
      if (exists) {
        await db.deleteFrom("user_permission_overrides").where("id", "=", override.id).execute();
      } else {
        await db
          .updateTable("user_permission_overrides")
          .set({ permission: mapped })
          .where("id", "=", override.id)
          .execute();
      }
    }

    await db
      .insertInto("audit_logs")
      .values({
        actor_id: null,
        action: "permissions.user_edit_granular",
        target_type: "system",
        target_id: "classes",
        detail_json: JSON.stringify({ removed: ["staff.user_edit"], added: [...basic, ...sensitive] }),
        ip: null,
        created_at: now,
      })
      .execute();

    // 保证迁移后所有用户名满足规则；不匹配时说明迁移算法异常。
    const remaining = await db.selectFrom("users").select(["id", "username"]).execute();
    for (const row of remaining) {
      if (!USERNAME_PATTERN.test(row.username)) {
        throw new Error(`username migration failed for user ${String(row.id)}: ${row.username}`);
      }
    }
  },
};
