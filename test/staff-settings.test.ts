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

describe("staff settings", () => {
  it("reads and updates site settings with validation", async () => {
    const current = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(current.statusCode).toBe(200);
    const settings = (current.json() as {
      settings: {
        site: { name: string; allow_guest_access: boolean };
        registration: { closed_registration_mode: string };
      };
    }).settings;
    expect(settings.site.name.length).toBeGreaterThan(0);
    expect(settings.site.allow_guest_access).toBe(true);
    expect(settings.registration.closed_registration_mode).toBe("auto");

    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        site: {
          tagline: "新的副标题",
          allow_guest_access: false,
          rules_markdown: "**规则**\n\n- 第一条",
        },
        registration: { open: true, closed_registration_mode: "message" },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { settings: { site: { tagline: string } } }).settings.site.tagline).toBe(
      "新的副标题",
    );
    expect(
      (updated.json() as { settings: { site: { allow_guest_access: boolean } } }).settings.site
        .allow_guest_access,
    ).toBe(false);
    expect(
      (updated.json() as { settings: { registration: { closed_registration_mode: string } } }).settings
        .registration.closed_registration_mode,
    ).toBe("message");

    const publicSite = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/site` });
    expect((publicSite.json() as { name: string }).name.length).toBeGreaterThan(0);

    const rules = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/rules` });
    expect(rules.statusCode).toBe(200);
    expect((rules.json() as { content: string }).content).toContain("**规则**");
  });

  it("manages operations settings with an independent permission", async () => {
    const current = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(current.statusCode).toBe(200);
    const initial = (current.json() as {
      settings: { economy: { bonus_enabled: boolean }; shop: { rename_cooldown_days: number } };
    }).settings;
    expect(initial.shop.rename_cooldown_days).toBeGreaterThanOrEqual(0);

    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { economy: { bonus_enabled: false } },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (updated.json() as { settings: { economy: { bonus_enabled: boolean } } }).settings.economy
        .bonus_enabled,
    ).toBe(false);

    const denied = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: user.cookieHeader },
    });
    expect(denied.statusCode).toBe(403);

    await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { economy: { bonus_enabled: true } },
    });
  });

  it("updates the independent seed points formula", async () => {
    const updated = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { seed_points: { formula: "result = seeders * 2" } },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (updated.json() as { settings: { seed_points: { formula: string } } }).settings.seed_points
        .formula,
    ).toBe("result = seeders * 2");

    const invalid = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/operations`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { seed_points: { formula: "result = " } },
    });
    expect(invalid.statusCode).toBe(400);
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

  it("saves independent bonus/class schedules and validates formulas", async () => {
    const initial = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader },
    });
    const body = initial.json() as {
      settings: { bonus: { cron: string; next_run_at: number | null; default_formula: string } };
    };
    expect(body.settings.bonus.cron).toBe("0 * * * *");
    expect(body.settings.bonus.default_formula).toContain("result");

    const invalidCron = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { bonus: { cron: "* * * * *" } },
    });
    expect(invalidCron.statusCode).toBe(400);

    const invalidFormula = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { bonus: { formula: "result = missing + 1" } },
    });
    expect(invalidFormula.statusCode).toBe(400);

    const saved = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        bonus: { cron: "30 * * * *", formula: "result = seeders + 1" },
        classes: { recalc_cron: "0 4 * * *" },
      },
    });
    expect(saved.statusCode).toBe(200);

    const preview = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/bonus/formula/preview`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { formula: "result = seeders + 2" },
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { result: number }).result).toBe(4);

    const userRow = await ctx.db
      .selectFrom("users")
      .select("id")
      .where("username", "=", "axue")
      .executeTakeFirstOrThrow();
    const simulate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/bonus/formula/simulate`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { formula: "result = seeders", user_id: Number(userRow.id) },
    });
    expect(simulate.statusCode).toBe(200);
    expect((simulate.json() as { username: string }).username).toBe("axue");

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/bonus/formula/preview`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: { formula: "result = 1" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
