import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { encodeBencode, parseTorrent } from "../src/lib/bencode.js";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let axue: LoggedIn;

const DUNE_HASH = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const GB = 1024 ** 3;

async function user(username: string) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  axue = await login(ctx.app, "阿雪", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("bonus", () => {
  it("settles accrual between last_bonus_at and now", async () => {
    const before = await user("lightbringer");
    await ctx.db
      .updateTable("users")
      .set({ last_bonus_at: Date.now() - 2 * 3_600_000 })
      .where("username", "=", "lightbringer")
      .execute();

    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/bonus`,
      headers: { cookie: admin.cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      balance: number;
      yield_per_hour: number;
      frozen_until: number | null;
      ledger: { kind: string }[];
      items: { key: string }[];
    };
    expect(body.yield_per_hour).toBeGreaterThan(0);
    expect(body.frozen_until).toBeNull();
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.ledger.length).toBeGreaterThanOrEqual(1);
    expect(body.balance).toBeGreaterThanOrEqual(Number(before.bonus));
  });

  it("requires login", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/me/bonus` });
    expect(res.statusCode).toBe(401);
  });
});

describe("exchange", () => {
  it("deducts bonus, writes ledger, and increases uploaded", async () => {
    const before = await user("lightbringer");

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/exchange/upload_10gb`,
      headers: {
        cookie: admin.cookieHeader,
        "x-csrf-token": admin.csrfToken,
        "idempotency-key": "exchange-test-1",
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { balance: number; item_key: string };
    expect(body.item_key).toBe("upload_10gb");

    const after = await user("lightbringer");
    expect(Number(before.bonus) - Number(after.bonus)).toBe(5000);
    expect(Number(after.uploaded) - Number(before.uploaded)).toBe(10 * GB);
    expect(body.balance).toBe(Number(after.bonus));

    const ledger = await ctx.db
      .selectFrom("bonus_ledger")
      .selectAll()
      .where("kind", "=", "exchange")
      .executeTakeFirst();
    expect(ledger).toBeTruthy();
    expect(Number(ledger?.delta)).toBe(-5000);
  });

  it("returns the same result for the same idempotency key", async () => {
    const before = await user("lightbringer");

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/exchange/upload_10gb`,
      headers: {
        cookie: admin.cookieHeader,
        "x-csrf-token": admin.csrfToken,
        "idempotency-key": "exchange-test-1",
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const after = await user("lightbringer");
    expect(Number(after.bonus)).toBe(Number(before.bonus));
  });

  it("rejects with insufficient bonus", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/exchange/upload_100gb`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("insufficient_bonus");
  });

  it("rejects while bonus is frozen and reports zero yield", async () => {
    await ctx.db
      .updateTable("users")
      .set({ bonus_frozen_until: Date.now() + 7 * 86_400_000 })
      .where("username", "=", "阿雪")
      .execute();

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/exchange/upload_10gb`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("bonus_frozen");

    const bonus = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/bonus`,
      headers: { cookie: axue.cookieHeader },
    });
    const body = bonus.json() as { frozen_until: number | null; yield_per_hour: number };
    expect(body.frozen_until).toBeGreaterThan(0);
    expect(body.yield_per_hour).toBe(0);

    await ctx.db
      .updateTable("users")
      .set({ bonus_frozen_until: null })
      .where("username", "=", "阿雪")
      .execute();
  });
});

describe("rss + downhash", () => {
  it("serves a signed feed and accepts its downhash without a cookie", async () => {
    const blob = encodeBencode({
      announce: "http://old.example/announce",
      info: {
        name: "Rss.Blob.2024.1080p",
        "piece length": 16384,
        pieces: Buffer.alloc(20, 1),
        length: 1024 * 1024,
      },
    });
    await ctx.db
      .updateTable("torrents")
      .set({ torrent_blob: blob })
      .where("info_hash", "=", DUNE_HASH)
      .execute();

    const lightbringer = await user("lightbringer");
    const res = await ctx.app.inject({
      method: "GET",
      url: `/rss?passkey=${lightbringer.passkey}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/rss+xml");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toContain("<enclosure");
    expect(res.body).toContain("downhash=");

    const match = res.body.match(/url="([^"]+)"/);
    expect(match).toBeTruthy();
    const absoluteUrl = (match?.[1] ?? "").replace(/&amp;/g, "&");
    const path = absoluteUrl.replace(/^https?:\/\/[^/]+/, "");

    const download = await ctx.app.inject({ method: "GET", url: path });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/x-bittorrent");

    const parsed = parseTorrent(download.rawPayload);
    expect(parsed.announce).toBe(`http://localhost:31002/announce/${lightbringer.passkey}`);
  });

  it("rejects a tampered downhash and a missing passkey", async () => {
    const tampered = await ctx.app.inject({
      method: "GET",
      url: "/t/1/download?downhash=2%7Cabc.def.ghi",
    });
    expect(tampered.statusCode).toBe(401);

    const missing = await ctx.app.inject({ method: "GET", url: "/rss" });
    expect(missing.statusCode).toBe(401);
  });
});
