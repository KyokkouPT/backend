import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import {
  createTestContext,
  login,
  TEST_PASSWORD,
  type LoggedIn,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let user: LoggedIn;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  user = await login(ctx.app, "阿雪", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

async function findUser(username: string): Promise<number> {
  const list = await ctx.app.inject({
    method: "GET",
    url: `${API_PREFIX}/staff/users?q=${encodeURIComponent(username)}`,
    headers: { cookie: admin.cookieHeader },
  });
  const item = (list.json() as { items: { id: number; username: string }[] }).items.find(
    (entry) => entry.username === username,
  );
  if (!item) throw new Error(`user ${username} not found`);
  return item.id;
}

describe("staff user management", () => {
  it("creates a user who can log in", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        username: "staffer",
        email: "staffer@example.com",
        password: "staffer-pass-123",
        role: "moderator",
        class_key: "moderator",
      },
    });
    expect(res.statusCode).toBe(201);
    await findUser("staffer");
    const staffer = await login(ctx.app, "staffer", "staffer-pass-123");
    expect(staffer.username).toBe("staffer");
  });

  it("updates role/status and revokes sessions on suspend", async () => {
    const id = await findUser("staffer");
    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { role: "user", status: "suspended" },
    });
    expect(updated.statusCode).toBe(200);

    const staffer = await login(ctx.app, "staffer", "staffer-pass-123").catch(() => null);
    expect(staffer).toBeNull();

    await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { role: "moderator", status: "active" },
    });
    const again = await login(ctx.app, "staffer", "staffer-pass-123");
    expect(again.username).toBe("staffer");
  });

  it("deletes a user without data and rejects users with data", async () => {
    const id = await findUser("staffer");
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
    });
    expect(removed.statusCode).toBe(200);

    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/users?q=staffer`,
      headers: { cookie: admin.cookieHeader },
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    const axue = await findUser("阿雪");
    const blocked = await ctx.app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/staff/users/${String(axue)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
    });
    expect(blocked.statusCode).toBe(409);
  });

  it("blocks self role/status changes and non-admin access", async () => {
    const self = await findUser("lightbringer");
    const roleChange = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(self)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "user" },
    });
    expect(roleChange.statusCode).toBe(400);

    const selfDelete = await ctx.app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/staff/users/${String(self)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
    });
    expect(selfDelete.statusCode).toBe(400);

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: {
        username: "nope",
        email: "nope@example.com",
        password: "nope-pass-123",
        role: "user",
        class_key: "user",
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("edits counted traffic, bonus and password without touching raw traffic", async () => {
    const id = await findUser("阿雪");
    const before = await ctx.db
      .selectFrom("users")
      .select(["bonus", "raw_uploaded", "raw_downloaded"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const GB = 1024 ** 3;

    const res = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        uploaded: 500 * GB,
        downloaded: 100 * GB,
        bonus: 999,
        password: "new-pass-12345",
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await ctx.db
      .selectFrom("users")
      .select(["uploaded", "downloaded", "bonus", "raw_uploaded", "raw_downloaded"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(Number(after.uploaded)).toBe(500 * GB);
    expect(Number(after.downloaded)).toBe(100 * GB);
    expect(Number(after.bonus)).toBe(999);
    expect(Number(after.raw_uploaded)).toBe(Number(before.raw_uploaded));
    expect(Number(after.raw_downloaded)).toBe(Number(before.raw_downloaded));

    const ledger = await ctx.db
      .selectFrom("bonus_ledger")
      .select(["kind", "delta"])
      .where("user_id", "=", id)
      .where("kind", "=", "adjust")
      .executeTakeFirst();
    expect(ledger).toBeTruthy();
    expect(Number(ledger?.delta)).toBe(999 - Number(before.bonus));

    const relogin = await login(ctx.app, "阿雪", "new-pass-12345");
    expect(relogin.username).toBe("阿雪");
  });
});
