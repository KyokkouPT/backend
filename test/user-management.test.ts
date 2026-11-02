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
  user = await login(ctx.app, "axue", TEST_PASSWORD);
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

  it("updates role/status and lets suspended users log in without permissions", async () => {
    const id = await findUser("staffer");
    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { role: "user", status: "suspended" },
    });
    expect(updated.statusCode).toBe(200);

    const staffer = await login(ctx.app, "staffer", "staffer-pass-123");
    const me = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: staffer.cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { status: string }; permissions: string[] }).user.status).toBe(
      "suspended",
    );
    expect((me.json() as { permissions: string[] }).permissions).toEqual([]);

    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/users`,
      headers: { cookie: staffer.cookieHeader },
    });
    expect(forbidden.statusCode).toBe(403);

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

    const axue = await findUser("axue");
    const blocked = await ctx.app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/staff/users/${String(axue)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
    });
    expect(blocked.statusCode).toBe(409);
  });

  it("allows self demotion but blocks self delete and non-admin access", async () => {
    const self = await findUser("lightbringer");
    const previous = await ctx.db
      .selectFrom("users")
      .select(["class_id", "class_key"])
      .where("id", "=", self)
      .executeTakeFirstOrThrow();
    const roleChange = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(self)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "user" },
    });
    expect(roleChange.statusCode).toBe(200);
    await ctx.db
      .updateTable("users")
      .set({ class_id: previous.class_id, class_key: previous.class_key })
      .where("id", "=", self)
      .execute();

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

  it("allows a staff edit to an auto class and clears the old demote warning", async () => {
    const id = await findUser("axue");
    const honor = await ctx.db
      .selectFrom("classes")
      .select("id")
      .where("slug", "=", "vip")
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("users")
      .set({
        class_id: Number(honor.id),
        class_key: "vip",
        demote_due_at: Date.now() + 86_400_000,
      })
      .where("id", "=", id)
      .execute();

    const res = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(id)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "member" },
    });
    expect(res.statusCode).toBe(200);

    const row = await ctx.db
      .selectFrom("users as u")
      .innerJoin("classes as c", "c.id", "u.class_id")
      .select(["c.slug", "u.demote_due_at"])
      .where("u.id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.slug).toBe("member");
    expect(row.demote_due_at).toBeNull();
  });

  it("edits counted traffic, bonus and password without touching raw traffic", async () => {
    const id = await findUser("axue");
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
        bonus: 999.006,
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
    expect(Number(after.bonus)).toBe(999.01);
    expect(Number(after.raw_uploaded)).toBe(Number(before.raw_uploaded));
    expect(Number(after.raw_downloaded)).toBe(Number(before.raw_downloaded));

    const ledger = await ctx.db
      .selectFrom("bonus_ledger")
      .select(["kind", "delta"])
      .where("user_id", "=", id)
      .where("kind", "=", "adjust")
      .executeTakeFirst();
    expect(ledger).toBeTruthy();
    expect(Number(ledger?.delta)).toBeCloseTo(999.01 - Number(before.bonus), 8);

    const relogin = await login(ctx.app, "axue", "new-pass-12345");
    expect(relogin.username).toBe("axue");
  });
});
