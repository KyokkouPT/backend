import type { Migration } from "./types.js";

/** 017_invite_email · 邀请码可预留注册邮箱。 */
export const migration017: Migration = {
  version: 17,
  name: "invite_email",
  async up({ db }) {
    try {
      await db.schema.alterTable("invites").addColumn("email", "varchar(190)").execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
    }
  },
};
