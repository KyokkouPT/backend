import type { Migration } from "./types.js";

/** 003_tracker · snatches 增加 completed_at，用于 event=completed 只累计一次。 */
export const migration003: Migration = {
  version: 3,
  name: "tracker",
  async up({ db }) {
    await db.schema.alterTable("snatches").addColumn("completed_at", "bigint").execute();
  },
};
