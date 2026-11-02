import type { Migration } from "./types.js";

/**
 * 027_class_reward_once · 记录用户首次达到过的最高等级。
 * 自动降级后再次升回同一等级时，不再重复发放邀请奖励。
 */
export const migration027: Migration = {
  version: 27,
  name: "class_reward_once",
  async up({ db }) {
    await db.schema
      .alterTable("users")
      .addColumn("max_class_once", "integer", (col) => col.notNull().defaultTo(1))
      .execute();

    const users = await db
      .selectFrom("users")
      .select(["id", "class_id"])
      .execute();
    const history = await db
      .selectFrom("user_class_history")
      .select(["user_id", "to_class_id"])
      .execute();
    const maxByUser = new Map<number, number>();
    for (const row of history) {
      maxByUser.set(
        Number(row.user_id),
        Math.max(maxByUser.get(Number(row.user_id)) ?? 1, Number(row.to_class_id)),
      );
    }
    for (const user of users) {
      const max = Math.max(
        1,
        user.class_id === null ? 1 : Number(user.class_id),
        maxByUser.get(Number(user.id)) ?? 1,
      );
      if (max > 1) {
        await db
          .updateTable("users")
          .set({ max_class_once: max })
          .where("id", "=", user.id)
          .execute();
      }
    }
  },
};
