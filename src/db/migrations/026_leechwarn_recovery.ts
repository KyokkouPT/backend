import type { Migration } from "./types.js";

/**
 * 026_leechwarn_recovery · 新用户等级不再使用空升级规则。
 * 空规则会被误判为“无条件满足”，导致受限用户每轮重算被升回新用户。
 */
export const migration026: Migration = {
  version: 26,
  name: "leechwarn_recovery",
  async up({ db }) {
    const row = await db
      .selectFrom("classes")
      .select(["id", "promote_rule_json"])
      .where("slug", "=", "user")
      .executeTakeFirst();
    if (!row) return;
    if (row.promote_rule_json === null) return;
    let promote: { logic?: unknown; conditions?: unknown } | null = null;
    try {
      const parsed: unknown = JSON.parse(row.promote_rule_json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        promote = parsed as { logic?: unknown; conditions?: unknown };
      }
    } catch {
      return;
    }
    if (!promote || !Array.isArray(promote.conditions) || promote.conditions.length > 0) {
      return;
    }
    await db
      .updateTable("classes")
      .set({
        promote_rule_json: JSON.stringify({
          logic: "any",
          conditions: [
            { metric: "ratio", op: ">=", value: 0.4 },
            { metric: "downloaded", op: "<=", value: 50, unit: "GB" },
          ],
        }),
        updated_at: Date.now(),
      })
      .where("id", "=", row.id)
      .execute();
  },
};
