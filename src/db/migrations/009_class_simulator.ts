import type { Migration } from "./types.js";
import { parseClassPermissions } from "../../lib/class-permissions.js";

/**
 * 009_class_simulator · 给默认管理等级追加模拟器/等级历史节点。
 * 只追加、不移除；已有该节点的等级跳过。
 */
export const migration009: Migration = {
  version: 9,
  name: "class_simulator",
  async up({ db }) {
    const additions = ["staff.class_simulate", "staff.class_history"];
    const rows = await db.selectFrom("classes").selectAll().execute();

    for (const row of rows) {
      if (row.slug !== "staff" && row.slug !== "owner") continue;
      const current = parseClassPermissions(row.permissions_json);
      if (!current.includes("staff.available")) continue;
      const next = [...new Set([...current, ...additions])];
      if (next.length === current.length) continue;
      await db
        .updateTable("classes")
        .set({ permissions_json: JSON.stringify(next), updated_at: Date.now() })
        .where("id", "=", row.id)
        .execute();
    }
  },
};
