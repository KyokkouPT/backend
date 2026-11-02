import type { Migration } from "./types.js";

/** 023_assessment_auto · 考核自动发现与优先级。 */
export const migration023: Migration = {
  version: 23,
  name: "assessment_auto",
  async up({ db }) {
    await db.schema
      .alterTable("assessments")
      .addColumn("auto_assign", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable("assessments")
      .addColumn("priority", "integer", (col) => col.notNull().defaultTo(0))
      .execute();
  },
};
