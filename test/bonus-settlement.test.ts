import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers.js";
import { runBonusSettlement } from "../src/lib/bonus.js";

let ctx: TestContext;
let userId = 0;
let userBonus = 0;

async function setFormula(formula: string): Promise<void> {
  const value = JSON.stringify({ cron: "0 * * * *", formula });
  await ctx.db
    .insertInto("site_settings")
    .values({ key: "bonus", value_json: value, updated_at: Date.now() })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value_json: value, updated_at: Date.now() }))
    .execute();
}

beforeAll(async () => {
  ctx = await createTestContext();
  const user = await ctx.db
    .selectFrom("users")
    .select(["id", "bonus"])
    .where("username", "=", "axue")
    .executeTakeFirstOrThrow();
  userId = Number(user.id);
  userBonus = Number(user.bonus);
  await ctx.db.deleteFrom("snatches").execute();
  const torrent = await ctx.db
    .selectFrom("torrents")
    .select(["section_id", "category_id"])
    .executeTakeFirstOrThrow();
  const torrentId = await ctx.db
    .insertInto("torrents")
    .values({
      info_hash: "aa".repeat(20),
      name: "bonus settlement test",
      section_id: Number(torrent.section_id),
      category_id: Number(torrent.category_id),
      uploader_id: userId,
      size: 10 * 1024 ** 3,
      files_count: 1,
      status: "approved",
      promo: "none",
      zero_bonus: 0,
      seeders: 1,
      leechers: 0,
      completed: 0,
      description: null,
      meta_json: "{}",
      torrent_blob: null,
      created_at: Date.now() - 7 * 86_400_000,
      approved_at: Date.now(),
      deleted_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto("snatches")
    .values({
      user_id: userId,
      torrent_id: Number(torrentId.id),
      uploaded: 0,
      downloaded: 0,
      seedtime: 0,
      last_announce_at: Date.now(),
      status: "seeding",
      completed_at: null,
    })
    .execute();
  await ctx.db.updateTable("users").set({ status: "suspended" }).where("id", "!=", userId).execute();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("bonus settlement", () => {
  it("credits a fractional hourly rate by the nominal interval", async () => {
    await setFormula("result = seeders * 10");
    await ctx.db.updateTable("users").set({ bonus: 0, bonus_frozen_until: null }).where("id", "=", userId).execute();
    const result = await runBonusSettlement(ctx.db, { intervalMs: 15 * 60 * 1000 });
    expect(result.credited).toBe(1);
    const after = await ctx.db.selectFrom("users").select("bonus").where("id", "=", userId).executeTakeFirstOrThrow();
    expect(Number(after.bonus)).toBeCloseTo(2.5, 8);
    const ledger = await ctx.db
      .selectFrom("bonus_ledger")
      .select(["kind", "delta"])
      .where("user_id", "=", userId)
      .where("kind", "=", "seeding")
      .executeTakeFirstOrThrow();
    expect(Number(ledger.delta)).toBeCloseTo(2.5, 8);
  });

  it("does not write zero deltas and respects freeze", async () => {
    await setFormula("result = 0");
    await ctx.db.deleteFrom("bonus_ledger").execute();
    await runBonusSettlement(ctx.db, { intervalMs: 60 * 60 * 1000 });
    const zeroRows = await ctx.db.selectFrom("bonus_ledger").select("id").execute();
    expect(zeroRows.length).toBe(0);

    await setFormula("result = seeders * 10");
    await ctx.db
      .updateTable("users")
      .set({ bonus_frozen_until: Date.now() + 3_600_000 })
      .where("id", "=", userId)
      .execute();
    const frozen = await runBonusSettlement(ctx.db, { intervalMs: 60 * 60 * 1000 });
    expect(frozen.credited).toBe(0);
  });

  it("allows negative results and writes a negative ledger row", async () => {
    await setFormula("result = -2");
    await ctx.db
      .updateTable("users")
      .set({ bonus: 10, bonus_frozen_until: null })
      .where("id", "=", userId)
      .execute();
    await runBonusSettlement(ctx.db, { intervalMs: 60 * 60 * 1000 });
    const after = await ctx.db.selectFrom("users").select("bonus").where("id", "=", userId).executeTakeFirstOrThrow();
    expect(Number(after.bonus)).toBeCloseTo(8, 8);
    const negative = await ctx.db
      .selectFrom("bonus_ledger")
      .select(["delta", "balance_after"])
      .where("user_id", "=", userId)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(Number(negative.delta)).toBeCloseTo(-2, 8);
    expect(Number(negative.balance_after)).toBeCloseTo(8, 8);
    void userBonus;
  });
});
