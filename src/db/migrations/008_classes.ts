import type { Migration } from "./types.js";
import { DEFAULT_CLASSES, ROLE_CLASS_MAP } from "../../lib/class-defaults.js";

/** 008_classes · 统一等级/权限体系、个人权限覆盖、等级历史与重算运行记录。 */
export const migration008: Migration = {
  version: 8,
  name: "classes",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : "bigint";

    await db.schema
      .createTable("classes")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("slug", "varchar(32)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(64)", (col) => col.notNull())
      .addColumn("rank", "integer", (col) => col.notNull())
      .addColumn("badge", "varchar(32)")
      .addColumn("color", "varchar(32)")
      .addColumn("description", "text", (col) => col.notNull().defaultTo(""))
      .addColumn("permissions_json", "text", (col) => col.notNull().defaultTo("[]"))
      .addColumn("invite_quota", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("auto_approve_quota", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("promote_rule_json", "text")
      .addColumn("demote_rule_json", "text")
      .addColumn("demote_target_slug", "varchar(32)")
      .addColumn("promote_grace_days", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("demote_grace_days", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("lock_manual", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("manual_grantable", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("visible", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("exempt_hr", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("exempt_ratio_matrix", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("user_permission_overrides")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("permission", "varchar(64)", (col) => col.notNull())
      .addColumn("effect", "varchar(8)", (col) => col.notNull())
      .addColumn("expires_at", "bigint")
      .addColumn("actor_id", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("user_permission_overrides_user_idx")
      .ifNotExists()
      .on("user_permission_overrides")
      .columns(["user_id"])
      .execute();

    await db.schema
      .createIndex("user_permission_overrides_unique_idx")
      .ifNotExists()
      .unique()
      .on("user_permission_overrides")
      .columns(["user_id", "permission"])
      .execute();

    await db.schema
      .createTable("user_class_history")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("from_class_id", "bigint")
      .addColumn("to_class_id", "bigint", (col) => col.notNull())
      .addColumn("source", "varchar(16)", (col) => col.notNull())
      .addColumn("reason", "varchar(190)", (col) => col.notNull())
      .addColumn("detail_json", "text")
      .addColumn("actor_id", "bigint")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("user_class_history_user_idx")
      .ifNotExists()
      .on("user_class_history")
      .columns(["user_id", "created_at"])
      .execute();

    await db.schema
      .createTable("class_recalc_runs")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("started_at", "bigint", (col) => col.notNull())
      .addColumn("finished_at", "bigint")
      .addColumn("scanned", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("promoted", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("demoted", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("error", "text")
      .addColumn("triggered_by", "varchar(16)", (col) => col.notNull())
      .addColumn("actor_id", "bigint")
      .execute();

    await db.schema
      .createTable("user_class_progress")
      .ifNotExists()
      .addColumn("id", idType, (col) => col.primaryKey().autoIncrement())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("target_class_id", "bigint", (col) => col.notNull())
      .addColumn("first_met_at", "bigint", (col) => col.notNull())
      .addColumn("last_checked_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("user_class_progress_unique_idx")
      .ifNotExists()
      .unique()
      .on("user_class_progress")
      .columns(["user_id", "target_class_id"])
      .execute();

    // SQLite/MySQL/PG 的 ADD COLUMN 兼容：重复列时忽略（迁移只执行一次，容错重跑）。
    const addColumn = async (column: string, dataType: "bigint" | "integer"): Promise<void> => {
      try {
        await db.schema
          .alterTable("users")
          .addColumn(column, dataType)
          .execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
      }
    };

    await addColumn("class_id", "bigint");
    await addColumn("warnings", "integer");
    await addColumn("invite_balance", "integer");
    await addColumn("class_locked_until", "bigint");
    await addColumn("demote_due_at", "bigint");

    await db.schema
      .createIndex("users_class_idx")
      .ifNotExists()
      .on("users")
      .columns(["class_id"])
      .execute();

    const now = Date.now();
    const existingRows = await db.selectFrom("classes").select(["id", "slug"]).execute();
    const existing = new Set(existingRows.map((row) => row.slug));

    for (const preset of DEFAULT_CLASSES) {
      if (existing.has(preset.slug)) continue;
      await db
        .insertInto("classes")
        .values({
          slug: preset.slug,
          name: preset.name,
          rank: preset.rank,
          badge: preset.badge,
          color: preset.color,
          description: preset.description,
          permissions_json: JSON.stringify(preset.permissions),
          invite_quota: preset.inviteQuota,
          auto_approve_quota: preset.autoApproveQuota,
          promote_rule_json: preset.promoteRule ? JSON.stringify(preset.promoteRule) : null,
          demote_rule_json: preset.demoteRule ? JSON.stringify(preset.demoteRule) : null,
          promote_grace_days: preset.promoteGraceDays,
          demote_grace_days: preset.demoteGraceDays,
          lock_manual: preset.lockManual ? 1 : 0,
          manual_grantable: preset.manualGrantable ? 1 : 0,
          visible: preset.visible ? 1 : 0,
          exempt_hr: preset.exemptHr ? 1 : 0,
          exempt_ratio_matrix: preset.exemptRatioMatrix ? 1 : 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const classRows = await db.selectFrom("classes").select(["id", "slug", "invite_quota"]).execute();
    const classBySlug = new Map(classRows.map((row) => [row.slug, row]));

    const users = await db.selectFrom("users").select(["id", "role", "class_id"]).execute();
    for (const user of users) {
      if (user.class_id !== null) continue;
      const slug = ROLE_CLASS_MAP[user.role] ?? ROLE_CLASS_MAP.user ?? "user";
      const target = classBySlug.get(slug) ?? classBySlug.get("user");
      if (!target) continue;
      await db
        .updateTable("users")
        .set({ class_id: target.id })
        .where("id", "=", user.id)
        .execute();
    }

    for (const row of classRows) {
      await db
        .updateTable("users")
        .set({ invite_balance: row.invite_quota, warnings: 0 })
        .where("class_id", "=", row.id)
        .execute();
    }
  },
};
