import type { Migration } from "./types.js";

/** 024_seed_points · 独立的做种积分累计值。 */
export const migration024: Migration = {
  version: 24,
  name: "seed_points",
  async up({ db }) {
    await db.schema
      .alterTable("users")
      .addColumn("seed_points", "double precision", (col) => col.notNull().defaultTo(0))
      .execute();
  },
};
