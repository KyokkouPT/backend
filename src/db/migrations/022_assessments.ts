import type { Migration } from "./types.js";

/** 022_assessments · 考核 / 任务模板、用户实例与指标进度。 */
export const migration022: Migration = {
  version: 22,
  name: "assessments",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("assessments")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("token", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("name", "varchar(190)", (col) => col.notNull())
      .addColumn("description_markdown", "text")
      .addColumn("type", "varchar(16)", (col) => col.notNull())
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("draft"))
      .addColumn("begin_at", "bigint")
      .addColumn("end_at", "bigint")
      .addColumn("duration_days", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("recurring", "varchar(16)", (col) => col.notNull().defaultTo("none"))
      .addColumn("filters_json", "text", (col) => col.notNull())
      .addColumn("requirements_json", "text", (col) => col.notNull())
      .addColumn("success_reward_json", "text", (col) => col.notNull())
      .addColumn("failure_penalty_json", "text", (col) => col.notNull())
      .addColumn("max_participants", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("allow_concurrent", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("settle_early", "integer", (col) => col.notNull().defaultTo(1))
      .addColumn("created_by", "bigint", (col) => col.notNull())
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("assessments_status_type_idx")
      .on("assessments")
      .columns(["status", "type"])
      .execute();

    await db.schema
      .createTable("assessment_assignments")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("token", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("assessment_id", "bigint", (col) => col.notNull())
      .addColumn("user_id", "bigint", (col) => col.notNull())
      .addColumn("period_key", "varchar(32)", (col) => col.notNull().defaultTo("once"))
      .addColumn("status", "varchar(16)", (col) => col.notNull())
      .addColumn("assigned_by", "bigint")
      .addColumn("assigned_at", "bigint", (col) => col.notNull())
      .addColumn("begin_at", "bigint", (col) => col.notNull())
      .addColumn("end_at", "bigint", (col) => col.notNull())
      .addColumn("baseline_json", "text", (col) => col.notNull())
      .addColumn("progress_json", "text", (col) => col.notNull())
      .addColumn("result_reason", "varchar(1000)")
      .addColumn("completed_at", "bigint")
      .addColumn("reward_applied", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("penalty_applied", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("assessment_assignments_user_status_idx")
      .on("assessment_assignments")
      .columns(["user_id", "status", "end_at"])
      .execute();
    await db.schema
      .createIndex("assessment_assignments_assessment_status_idx")
      .on("assessment_assignments")
      .columns(["assessment_id", "status"])
      .execute();
    await db.schema
      .createIndex("assessment_assignments_end_idx")
      .on("assessment_assignments")
      .columns(["status", "end_at"])
      .execute();
    await db.schema
      .createIndex("assessment_assignments_period_uq")
      .unique()
      .on("assessment_assignments")
      .columns(["assessment_id", "user_id", "period_key"])
      .execute();

    await db.schema
      .createTable("assessment_progress")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("assignment_id", "bigint", (col) => col.notNull())
      .addColumn("metric", "varchar(32)", (col) => col.notNull())
      .addColumn("baseline_value", "double precision", (col) => col.notNull().defaultTo(0))
      .addColumn("current_value", "double precision", (col) => col.notNull().defaultTo(0))
      .addColumn("target_value", "double precision", (col) => col.notNull())
      .addColumn("updated_at", "bigint", (col) => col.notNull())
      .execute();

    await db.schema
      .createIndex("assessment_progress_assignment_idx")
      .on("assessment_progress")
      .columns(["assignment_id"])
      .execute();
    await db.schema
      .createIndex("assessment_progress_metric_uq")
      .unique()
      .on("assessment_progress")
      .columns(["assignment_id", "metric"])
      .execute();

    await db.schema.alterTable("users").addColumn("suspended_until", "bigint").execute();
  },
};
