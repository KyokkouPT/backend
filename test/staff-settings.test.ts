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

describe("staff settings", () => {
  it("reads and updates site settings with validation", async () => {
    const current = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(current.statusCode).toBe(200);
    const settings = (current.json() as { settings: { site: { name: string } } }).settings;
    expect(settings.site.name.length).toBeGreaterThan(0);

    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { site: { tagline: "新的副标题" }, registration: { open: true } },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { settings: { site: { tagline: string } } }).settings.site.tagline).toBe(
      "新的副标题",
    );

    const publicSite = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/site` });
    expect((publicSite.json() as { name: string }).name.length).toBeGreaterThan(0);
  });

  it("rejects invalid settings and non-admin access", async () => {
    const invalid = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { tracker: { announce_interval: 5 } },
    });
    expect(invalid.statusCode).toBe(400);

    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: user.cookieHeader },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("lists and updates sections and categories", async () => {
    const sections = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(sections.statusCode).toBe(200);
    const items = (sections.json() as { items: { slug: string; name: string; categories: unknown[] }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    const target = items[0];
    expect(target).toBeTruthy();

    const rename = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/sections/${String(target?.slug)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { name: `${String(target?.name)} 测试`, review_mode: "review" },
    });
    expect(rename.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: admin.cookieHeader },
    });
    const renamed = (after.json() as { items: { slug: string; name: string }[] }).items.find(
      (section) => section.slug === target?.slug,
    );
    expect(renamed?.name).toBe(`${String(target?.name)} 测试`);

    await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/sections/${String(target?.slug)}`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { name: target?.name },
    });

    const missing = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/sections/does-not-exist`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates sections and categories and rejects duplicates", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "anime", name: "动画", review_mode: "pre", display_order: 9 },
    });
    expect(create.statusCode).toBe(201);

    const duplicate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { slug: "anime", name: "动画2", review_mode: "pre" },
    });
    expect(duplicate.statusCode).toBe(409);

    const category = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/categories`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { section_slug: "anime", slug: "anime-sub", name: "字幕" },
    });
    expect(category.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: admin.cookieHeader },
    });
    const anime = (
      list.json() as { items: { slug: string; categories: { slug: string }[] }[] }
    ).items.find((section) => section.slug === "anime");
    expect(anime?.categories.some((entry) => entry.slug === "anime-sub")).toBe(true);

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/sections`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: { slug: "nope", name: "nope", review_mode: "pre" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
