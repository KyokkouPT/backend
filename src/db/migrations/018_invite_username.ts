import type { Migration } from "./types.js";

/** 018_invite_username · 邀请码可预留注册用户名。 */
export const migration018: Migration = {
  version: 18,
  name: "invite_username",
  async up({ db }) {
    try {
      await db.schema.alterTable("invites").addColumn("username", "varchar(64)").execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
    }
  },
};
