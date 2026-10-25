import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, type TestContext } from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("site / bootstrap / home / rules", () => {
  it("GET /site returns configured identity and registration", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/site` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      name: string;
      version: string;
      registration: { open: boolean };
      footer: { copyright: string };
    };
    expect(body.name).toBe("KyokkouPT");
    expect(body.version).toBe("0.1.0");
    expect(body.registration.open).toBe(true);
    expect(body.footer.copyright).toContain("KyokkouPT");
  });

  it("GET /bootstrap works anonymously", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/bootstrap` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      me: unknown;
      permissions: string[];
      sections: { slug: string; categories: unknown[] }[];
      nav: { site: { items: unknown[] }[] };
      counts: { pending_review: number };
      config_version: string;
    };

    expect(body.me).toBeNull();
    expect(body.permissions).toEqual([]);
    expect(body.sections).toHaveLength(6);
    expect(body.sections.reduce((sum, section) => sum + section.categories.length, 0)).toBe(23);
    expect(body.nav.site).toHaveLength(1);
    expect(body.counts.pending_review).toBe(0);
    expect(body.config_version).toBe("1");
  });

  it("GET /bootstrap includes me and staff permissions when logged in", async () => {
    const session = await login(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/bootstrap`,
      headers: { cookie: session.cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      me: { username: string; role: string };
      permissions: string[];
      nav: { site: { label?: string }[] };
    };
    expect(body.me.username).toBe("lightbringer");
    expect(body.me.role).toBe("admin");
    expect(body.permissions).toContain("staff.access");
    expect(body.nav.site).toHaveLength(2);
    expect(body.nav.site[1]?.label).toBe("我的");
  });

  it("GET /home returns real stats, torrents and announcements", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/home` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stats: { torrents: number; users: number; seeders: number; peers: number };
      latest: { name: string; tags: string[]; size: number; download_url: string }[];
      announcements: { title: string }[];
      promos: unknown[];
      my: unknown;
    };

    expect(body.stats.torrents).toBeGreaterThanOrEqual(8);
    expect(body.stats.users).toBe(3);
    expect(body.stats.seeders).toBeGreaterThan(0);
    expect(body.stats.peers).toBe(
      (body.stats.seeders ?? 0) + ((body.stats as { leechers?: number }).leechers ?? 0),
    );
    expect(body.latest).toHaveLength(8);
    expect(body.latest[0]?.name).toBeTruthy();
    expect(Array.isArray(body.latest[0]?.tags)).toBe(true);
    expect(body.latest[0]?.download_url).toMatch(/^\/t\/\d+\/download$/);
    expect(body.announcements.length).toBeGreaterThanOrEqual(3);
    expect(body.promos.length).toBeGreaterThanOrEqual(2);
    expect(body.my).toBeNull();
  });

  it("GET /rules returns configuration-driven sections", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/rules` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      registration: { open: boolean };
      hnr: { deadline_days: number; seed_seconds: number };
      tracker: { announce_interval: number };
      sections: { slug: string; fields: { key: string }[] }[];
    };

    expect(body.registration.open).toBe(true);
    expect(body.hnr.deadline_days).toBe(14);
    expect(body.hnr.seed_seconds).toBe(72 * 3600);
    expect(body.tracker.announce_interval).toBe(1800);
    expect(body.sections).toHaveLength(6);
    expect(body.sections.find((section) => section.slug === "movie")?.fields.length).toBeGreaterThan(0);
  });

  it("GET /me requires login and returns the user's real stats", async () => {
    const anonymous = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/me` });
    expect(anonymous.statusCode).toBe(401);

    const session = await login(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me`,
      headers: { cookie: session.cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: { username: string; uploaded: number; ratio: number | null };
      stats: { published: number; seeding: number; leeching: number };
      hnr: unknown[];
      snatches: unknown[];
    };
    expect(body.user.username).toBe("lightbringer");
    expect(body.user.uploaded).toBeGreaterThan(0);
    expect(body.user.ratio).toBeGreaterThan(0);
    expect(body.stats.published).toBeGreaterThanOrEqual(1);
    expect(body.hnr).toEqual([]);
    expect(body.snatches).toEqual([]);
  });

  it("unknown API paths return problem+json 404", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/does-not-exist` });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect((res.json() as { code: string }).code).toBe("not_found");
  });
});
