import type { Migration } from "./types.js";

/** 025_staff_operations · 把运营设置从站点设置权限中拆为独立权限。 */
export const migration025: Migration = {
  version: 25,
  name: "staff_operations",
  async up({ db }) {
    const rows = await db
      .selectFrom("classes")
      .select(["id", "permissions_json"])
      .execute();
    const now = Date.now();
    for (const row of rows) {
      let permissions: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.permissions_json);
        if (Array.isArray(parsed)) {
          permissions = parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        continue;
      }
      // 已有站点设置权限的角色默认继承运营设置；之后可由等级管理单独收回。
      if (!permissions.includes("staff.settings") || permissions.includes("staff.operations")) {
        continue;
      }
      await db
        .updateTable("classes")
        .set({
          permissions_json: JSON.stringify([...permissions, "staff.operations"]),
          updated_at: now,
        })
        .where("id", "=", row.id)
        .execute();
    }
  },
};
