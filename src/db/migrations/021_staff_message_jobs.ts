import type { Migration } from "./types.js";

/** 021_staff_message_jobs · Staff 群发站内信后台任务。 */
export const migration021: Migration = {
  version: 21,
  name: "staff_message_jobs",
  async up({ db, dialect }) {
    const idType = dialect === "sqlite" ? "integer" : dialect === "postgres" ? "bigserial" : "bigint";

    await db.schema
      .createTable("staff_message_jobs")
      .ifNotExists()
      .addColumn("id", idType, (col) => (dialect === "postgres" ? col.primaryKey() : col.primaryKey().autoIncrement()))
      .addColumn("token", "varchar(64)", (col) => col.notNull().unique())
      .addColumn("actor_id", "bigint", (col) => col.notNull())
      .addColumn("payload_json", "text", (col) => col.notNull())
      .addColumn("status", "varchar(16)", (col) => col.notNull().defaultTo("queued"))
      .addColumn("recipients", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("error", "text")
      .addColumn("created_at", "bigint", (col) => col.notNull())
      .addColumn("started_at", "bigint")
      .addColumn("finished_at", "bigint")
      .execute();

    await db.schema
      .createIndex("staff_message_jobs_status_created_idx")
      .on("staff_message_jobs")
      .columns(["status", "created_at"])
      .execute();
  },
};
