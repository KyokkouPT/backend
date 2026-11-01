import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let owner: LoggedIn;
let torrentId = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  owner = await login(ctx.app, "阿雪", TEST_PASSWORD);
  const torrent = await ctx.db
    .selectFrom("torrents")
    .select("id")
    .where("status", "=", "approved")
    .executeTakeFirstOrThrow();
  torrentId = Number(torrent.id);
  await ctx.db
    .updateTable("torrents")
    .set({ uploader_id: owner.userId, zero_bonus: 0 })
    .where("id", "=", torrentId)
    .execute();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("zero bonus flag", () => {
  it("lets the uploader toggle and exposes it in the torrent detail", async () => {
    const toggled = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/torrents/${String(torrentId)}/zero-bonus`,
      headers: { cookie: owner.cookieHeader, "x-csrf-token": owner.csrfToken },
      payload: { zero_bonus: true },
    });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as { zero_bonus: boolean }).zero_bonus).toBe(true);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/torrents/${String(torrentId)}`,
      headers: { cookie: owner.cookieHeader },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { zero_bonus: boolean }).zero_bonus).toBe(true);
  });

  it("lets staff toggle any torrent and requires authentication", async () => {
    const staffToggle = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/torrents/${String(torrentId)}/zero-bonus`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { zero_bonus: false },
    });
    expect(staffToggle.statusCode).toBe(200);

    const anonymous = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/torrents/${String(torrentId)}/zero-bonus`,
      payload: { zero_bonus: true },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
