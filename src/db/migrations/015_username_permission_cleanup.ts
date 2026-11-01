import type { Migration } from "./types.js";

/** 015_username_permission_cleanup · 管理组默认不保留 class/status 子权限。 */
export const migration015: Migration = {
  version: 15,
  name: "username_permission_cleanup",
  async up({ db }) {
    const now = Date.now();
    const staff = await db
      .selectFrom("classes")
      .select(["id", "permissions_json"])
      .where("slug", "=", "staff")
      .executeTakeFirst();
    if (!staff) return;

    let permissions: string[] = [];
    try {
      const parsed: unknown = JSON.parse(staff.permissions_json);
      if (Array.isArray(parsed)) {
        permissions = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      permissions = [];
    }
    const next = permissions.filter(
      (permission) =>
        permission !== "staff.user_edit.class" &&
        permission !== "staff.user_edit.status" &&
        permission !== "staff.user_edit.custom_title",
    );
    if (next.length !== permissions.length) {
      await db
        .updateTable("classes")
        .set({ permissions_json: JSON.stringify(next.sort()), updated_at: now })
        .where("id", "=", staff.id)
        .execute();
    }
    await db
      .insertInto("audit_logs")
      .values({
        actor_id: null,
        action: "permissions.user_edit_staff_defaults",
        target_type: "system",
        target_id: "classes",
        detail_json: JSON.stringify({ removed: ["class", "status", "custom_title"] }),
        ip: null,
        created_at: now,
      })
      .execute();
  },
};
