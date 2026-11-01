import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let axue: LoggedIn;
const GB = 1024 ** 3;

async function user(name: string) {
  return ctx.db.selectFrom("users").selectAll().where("username", "=", name).executeTakeFirstOrThrow();
}

async function createItem(input: {
  key: string;
  name: string;
  direction: "buy" | "sell";
  type: string;
  amount?: number | null;
  price: number;
  params?: Record<string, unknown>;
  inventory?: number | null;
  limit?: number | null;
}) {
  await ctx.db
    .insertInto("exchange_items")
    .values({
      key: input.key,
      name: input.name,
      description: null,
      price: input.price,
      inventory: input.inventory ?? null,
      limit_per_user: input.limit ?? null,
      enabled: 1,
      payload_json: "{}",
      display_order: 100,
      direction: input.direction,
      type: input.type,
      amount: input.amount ?? null,
      params_json: input.params ? JSON.stringify(input.params) : null,
      min_class_rank: null,
    })
    .execute();
}

async function exchange(key: string, params: Record<string, unknown> = {}, keyId?: string) {
  return ctx.app.inject({
    method: "POST",
    url: `${API_PREFIX}/me/exchange/${key}`,
    headers: {
      cookie: axue.cookieHeader,
      "x-csrf-token": axue.csrfToken,
      ...(keyId ? { "idempotency-key": keyId } : {}),
    },
    payload: { params, ...(keyId ? { idempotency_key: keyId } : {}) },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  axue = await login(ctx.app, "axue", TEST_PASSWORD);
  await ctx.db
    .updateTable("users")
    .set({ bonus: 10000, uploaded: 100 * GB, downloaded: 50 * GB, invite_balance: 5 })
    .where("username", "=", "axue")
    .execute();
  await createItem({ key: "shop_upload", name: "上传 10G", direction: "buy", type: "upload_add", amount: 10 * GB, price: 100 });
  await createItem({ key: "shop_download", name: "下载 5G", direction: "buy", type: "download_add", amount: 5 * GB, price: 50 });
  await createItem({ key: "shop_reduce", name: "减免 5G", direction: "buy", type: "download_reduce", amount: 5 * GB, price: 40 });
  await createItem({ key: "shop_invite", name: "邀请", direction: "buy", type: "invite_add", amount: 1, price: 30 });
  await createItem({ key: "shop_title", name: "头衔", direction: "buy", type: "title_set", price: 20, params: { max_length: 12 } });
  await createItem({ key: "shop_gift", name: "送礼", direction: "buy", type: "gift_bonus", amount: 100, price: 110, params: { fee_ratio: 0.1 } });
  await createItem({ key: "shop_username", name: "改名", direction: "buy", type: "username_change", price: 60 });
  await createItem({ key: "shop_hnr", name: "H&R 机会", direction: "buy", type: "hnr_clear", amount: 2, price: 80 });
  await createItem({ key: "shop_sell_invite", name: "卖邀请", direction: "sell", type: "invite_sell", amount: 1, price: 25 });
  await createItem({ key: "shop_sell_upload", name: "卖上传", direction: "sell", type: "upload_sell", amount: 5 * GB, price: 35 });
  await createItem({ key: "shop_stock", name: "限量", direction: "buy", type: "upload_add", amount: GB, price: 1, inventory: 1 });
  await createItem({ key: "shop_limit", name: "限次", direction: "buy", type: "upload_add", amount: GB, price: 1, limit: 1 });
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("bonus shop admin", () => {
  it("creates, lists, toggles and audits items with staff.bonus_shop", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/bonus/items`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        key: "Admin_Created",
        name: "管理员创建",
        direction: "buy",
        type: "upload_add",
        amount: 2 * GB,
        price: 10,
        display_order: 3,
      },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { key: string }).key).toBe("admin_created");
    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/bonus/items`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: { key: string }[] }).items.some((item) => item.key === "admin_created")).toBe(true);

    const itemId = (created.json() as { id: number }).id;
    const toggled = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/bonus/items/${String(itemId)}/toggle`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it("rejects non-shop staff", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/bonus/items`,
      headers: { cookie: axue.cookieHeader },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("bonus shop exchange", () => {
  it("applies traffic, invite and title purchases", async () => {
    const before = await user("axue");
    expect((await exchange("shop_upload")).statusCode).toBe(200);
    expect((await exchange("shop_download")).statusCode).toBe(200);
    expect((await exchange("shop_reduce")).statusCode).toBe(200);
    expect((await exchange("shop_invite")).statusCode).toBe(200);
    const title = await exchange("shop_title", { title: "测试头衔" });
    expect(title.statusCode).toBe(200);

    const after = await user("axue");
    expect(Number(after.uploaded) - Number(before.uploaded)).toBe(10 * GB);
    expect(Number(after.downloaded)).toBe(Number(before.downloaded) + 5 * GB - 5 * GB);
    expect(Number(after.invite_balance)).toBe(Number(before.invite_balance) + 1);
    expect(after.custom_title).toBe("测试头衔");
    expect(Number(after.raw_uploaded)).toBe(Number(before.raw_uploaded));
    expect(Number(after.raw_downloaded)).toBe(Number(before.raw_downloaded));
  });

  it("gifts bonus with fee, ledger and notification", async () => {
    const senderBefore = await user("axue");
    const recipientBefore = await user("root");
    const res = await exchange("shop_gift", { recipient: "root", message: "谢谢" });
    expect(res.statusCode).toBe(200);
    const senderAfter = await user("axue");
    const recipientAfter = await user("root");
    expect(Number(senderBefore.bonus) - Number(senderAfter.bonus)).toBe(110);
    expect(Number(recipientAfter.bonus) - Number(recipientBefore.bonus)).toBe(100);
    const notification = await ctx.db
      .selectFrom("notifications")
      .select("id")
      .where("user_id", "=", recipientBefore.id)
      .where("title", "=", "收到魔力值赠送")
      .executeTakeFirst();
    expect(notification).toBeTruthy();
  });

  it("sells invite and uploaded traffic", async () => {
    const before = await user("axue");
    expect((await exchange("shop_sell_invite")).statusCode).toBe(200);
    expect((await exchange("shop_sell_upload")).statusCode).toBe(200);
    const after = await user("axue");
    expect(Number(after.invite_balance)).toBe(Number(before.invite_balance) - 1);
    expect(Number(before.uploaded) - Number(after.uploaded)).toBe(5 * GB);
    expect(Number(after.bonus)).toBeGreaterThan(Number(before.bonus));
  });

  it("buys H&R credits and clears only an unreached obligation", async () => {
    const torrent = await ctx.db.selectFrom("torrents").select("id").executeTakeFirstOrThrow();
    const axueRow = await user("axue");
    await ctx.db
      .insertInto("hnr_obligations")
      .values({
        user_id: Number(axueRow.id),
        torrent_id: Number(torrent.id),
        policy_id: null,
        required_seconds: 3600,
        seeded_seconds: 0,
        deadline_at: Date.now() - 1000,
        status: "unreached",
        resolved_at: null,
        created_at: Date.now(),
      })
      .execute();
    const obligationRow = await ctx.db
      .selectFrom("hnr_obligations")
      .select("id")
      .where("user_id", "=", axueRow.id)
      .where("torrent_id", "=", torrent.id)
      .executeTakeFirstOrThrow();
    expect((await exchange("shop_hnr")).statusCode).toBe(200);
    const me = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me`,
      headers: { cookie: axue.cookieHeader },
    });
    expect((me.json() as { hnr_credits: number }).hnr_credits).toBe(2);

    const clear = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/hnr/${String(obligationRow.id)}/clear`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
      payload: {},
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { credits: number }).credits).toBe(1);
    const cleared = await ctx.db
      .selectFrom("hnr_obligations")
      .select("status")
      .where("id", "=", obligationRow.id)
      .executeTakeFirstOrThrow();
    expect(cleared.status).toBe("cleared");
  });

  it("writes failed records and enforces stock/limit/idempotency", async () => {
    const insufficient = await exchange("shop_upload", {}, "shop-idem-1");
    expect(insufficient.statusCode).toBe(200);
    const replay = await exchange("shop_upload", {}, "shop-idem-1");
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { redemption_id: number }).redemption_id).toBe(
      (insufficient.json() as { redemption_id: number }).redemption_id,
    );

    await ctx.db
      .updateTable("users")
      .set({ bonus: 0 })
      .where("username", "=", "axue")
      .execute();
    const failed = await exchange("shop_upload");
    expect(failed.statusCode).toBe(400);
    const failedRows = await ctx.db
      .selectFrom("redemptions")
      .selectAll()
      .where("user_id", "=", (await user("axue")).id)
      .where("status", "=", "failed")
      .execute();
    expect(failedRows.length).toBeGreaterThanOrEqual(1);

    await ctx.db
      .updateTable("users")
      .set({ bonus: 10000 })
      .where("username", "=", "axue")
      .execute();
    expect((await exchange("shop_stock")).statusCode).toBe(200);
    expect((await exchange("shop_stock")).statusCode).toBe(409);
    expect((await exchange("shop_limit")).statusCode).toBe(200);
    expect((await exchange("shop_limit")).statusCode).toBe(409);
  });

  it("changes username and writes redemption type", async () => {
    const current = await user("axue");
    const res = await exchange("shop_username", { username: "axue_shop" });
    expect(res.statusCode).toBe(200);
    const changed = await ctx.db
      .selectFrom("users")
      .select(["username", "username_changed_at"])
      .where("id", "=", current.id)
      .executeTakeFirstOrThrow();
    expect(changed.username).toBe("axue_shop");
    const redemption = await ctx.db
      .selectFrom("redemptions")
      .select(["type", "params_json"])
      .where("user_id", "=", current.id)
      .where("type", "=", "username_change")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(redemption.type).toBe("username_change");

    const revert = await exchange("shop_username", { username: "axue" });
    expect(revert.statusCode).toBe(200);
    const restored = await ctx.db
      .selectFrom("users")
      .select(["username", "bonus"])
      .where("id", "=", current.id)
      .executeTakeFirstOrThrow();
    expect(restored.username).toBe("axue");
    const refundLedger = await ctx.db
      .selectFrom("bonus_ledger")
      .select(["delta", "kind"])
      .where("user_id", "=", current.id)
      .where("kind", "=", "exchange")
      .where("ref_id", "=", "shop_username")
      .orderBy("id", "desc")
      .executeTakeFirst();
    expect(refundLedger).toBeTruthy();
    expect(Number(refundLedger?.delta)).toBe(60);
  });
});
