import type { Migration } from "./types.js";

/**
 * 010_raw_traffic · 区分实际流量与计入流量。
 *
 * - raw_uploaded / raw_downloaded：Tracker 实际上报量（不打折、不受兑换影响）
 * - uploaded / downloaded：计入量（促销系数 + 上传兑换 − 下载减免），评级继续用它
 *
 * 历史回填：老用户 raw_* = 当前 uploaded/downloaded。
 */
export const migration010: Migration = {
  version: 10,
  name: "raw_traffic",
  async up({ db }) {
    const addColumn = async (column: string): Promise<void> => {
      try {
        await db.schema
          .alterTable("users")
          .addColumn(column, "bigint", (col) => col.notNull().defaultTo(0))
          .execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column|already exists|Duplicate column/i.test(message)) throw error;
      }
    };

    await addColumn("raw_uploaded");
    await addColumn("raw_downloaded");

    await db
      .updateTable("users")
      .set((eb) => ({
        raw_uploaded: eb.ref("uploaded"),
        raw_downloaded: eb.ref("downloaded"),
      }))
      .execute();
  },
};
