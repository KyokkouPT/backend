import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let member: LoggedIn;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  member = await login(ctx.app, "阿雪", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

async function userId(username: string): Promise<number> {
  const row = await ctx.db
    .selectFrom("users")
    .select("id")
    .where("username", "=", username)
    .executeTakeFirst();
  if (!row) throw new Error(`user ${username} not found`);
  return Number(row.id);
}

describe("class system", () => {
  it("exposes classes and gates staff permissions", async () => {
    const classes = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/classes` });
    expect(classes.statusCode).toBe(200);
    const slugs = (classes.json() as { items: { slug: string }[] }).items.map((item) => item.slug);
    expect(slugs).toContain("user");
    expect(slugs).toContain("member");

    const meAdmin = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(meAdmin.statusCode).toBe(200);
    const adminBody = meAdmin.json() as { permissions: string[]; user: { class: { slug: string } } };
    expect(adminBody.permissions).toContain("staff.available");
    expect(adminBody.user.class.slug).toBe("owner");

    const meMember = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: member.cookieHeader },
    });
    const memberBody = meMember.json() as { permissions: string[] };
    expect(memberBody.permissions).not.toContain("staff.available");
    expect(memberBody.permissions.some((p) => p.startsWith("staff."))).toBe(false);
  });

  it("creates classes and rejects invalid staff permission sets", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "test-tier", name: "测试等级", rank: 35, permissions: ["rss.read"] },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "test-tier", name: "重复", rank: 36, permissions: [] },
    });
    expect(duplicate.statusCode).toBe(409);

    const invalid = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "bad-staff", name: "坏管理", rank: 37, permissions: ["staff.users"] },
    });
    expect(invalid.statusCode).toBe(400);

    const tooHigh = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "too-high", name: "过高", rank: 95, permissions: [] },
    });
    expect(tooHigh.statusCode).toBe(403);
  });

  it("validates manual class changes", async () => {
    const target = await userId("阿雪");
    const promote = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(target)}/class`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "member" },
    });
    expect(promote.statusCode).toBe(200);

    const downgrade = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(target)}/class`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "user" },
    });
    expect(downgrade.statusCode).toBe(400);

    const unknown = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(target)}/class`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { class_slug: "nope" },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("does not let personal grants bypass the staff gate", async () => {
    const target = await userId("阿雪");
    const saved = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/users/${String(target)}/permissions`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { extra: ["staff.access"], denied: [] },
    });
    expect(saved.statusCode).toBe(200);

    const me = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: member.cookieHeader },
    });
    const body = me.json() as { permissions: string[] };
    expect(body.permissions).not.toContain("staff.access");
    expect(body.permissions.some((p) => p.startsWith("staff."))).toBe(false);
  });

  it("runs recalc: promotes eligible users and demotes when ratio drops", async () => {
    const target = await userId("阿雪");
    const userClass = await ctx.db
      .selectFrom("classes")
      .select("id")
      .where("slug", "=", "user")
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("users")
      .set({
        class_id: Number(userClass.id),
        class_key: "user",
        uploaded: 200 * 1024 ** 3,
        downloaded: 60 * 1024 ** 3,
        created_at: Date.now() - 60 * 86_400_000,
      })
      .where("id", "=", target)
      .execute();

    const first = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes/recalc`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { promoted: number };
    expect(firstBody.promoted).toBeGreaterThanOrEqual(1);

    const promotedRow = await ctx.db
      .selectFrom("users as u")
      .innerJoin("classes as c", "c.id", "u.class_id")
      .select(["c.slug", "u.invite_balance"])
      .where("u.id", "=", target)
      .executeTakeFirstOrThrow();
    expect(promotedRow.slug).toBe("member");
    expect(Number(promotedRow.invite_balance)).toBeGreaterThanOrEqual(1);

    await ctx.db
      .updateTable("users")
      .set({ uploaded: 0, downloaded: 30 * 1024 ** 3 })
      .where("id", "=", target)
      .execute();
    await ctx.db
      .updateTable("classes")
      .set({ demote_grace_days: 0 })
      .where("slug", "=", "member")
      .execute();

    const second = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/classes/recalc`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { demoted: number }).demoted).toBeGreaterThanOrEqual(1);

    const demotedRow = await ctx.db
      .selectFrom("users as u")
      .innerJoin("classes as c", "c.id", "u.class_id")
      .select("c.slug")
      .where("u.id", "=", target)
      .executeTakeFirstOrThrow();
    expect(demotedRow.slug).toBe("user");

    const runs = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/classes/runs`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(runs.statusCode).toBe(200);
    expect((runs.json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);
  });
});
