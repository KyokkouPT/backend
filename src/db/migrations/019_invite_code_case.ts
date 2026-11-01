import type { Migration } from "./types.js";

/** 019_invite_code_case · 邀请码统一大写，便于大小写不敏感比对。 */
export const migration019: Migration = {
  version: 19,
  name: "invite_code_case",
  async up({ db }) {
    const rows = await db.selectFrom("invites").select(["id", "code"]).execute();
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const row of rows) {
      const normalized = row.code.toUpperCase();
      const other = seen.get(normalized);
      if (other && other !== row.code) {
        conflicts.push(`${other} / ${row.code}`);
      } else {
        seen.set(normalized, row.code);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(`invite codes collide after upper-casing: ${conflicts.join(", ")}`);
    }

    for (const row of rows) {
      if (row.code !== row.code.toUpperCase()) {
        await db.updateTable("invites").set({ code: row.code.toUpperCase() }).where("id", "=", row.id).execute();
      }
    }
  },
};
