import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { encodeBencode, parseTorrent } from "../src/lib/bencode.js";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let user: LoggedIn;
let uploadedId = 0;
let uploadedInfoHash = "";

function makeTorrent(name: string): Buffer {
  return encodeBencode({
    announce: "http://old.example/announce",
    "announce-list": [["http://old.example/announce"]],
    comment: "kyokkou test torrent",
    info: {
      name,
      "piece length": 16384,
      pieces: Buffer.alloc(20, 7),
      length: 1024 * 1024,
    },
  });
}

function multipart(
  file: Buffer,
  fields: Record<string, string>,
): { body: Buffer; contentType: string } {
  const boundary = "----kyokkou-test-boundary";
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`,
    ),
    file,
    Buffer.from("\r\n"),
  ];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadHeaders(session: LoggedIn, contentType: string): Record<string, string> {
  return {
    cookie: session.cookieHeader,
    "x-csrf-token": session.csrfToken,
    "content-type": contentType,
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  user = await login(ctx.app, "axue", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("torrent catalog", () => {
  it("lists approved torrents anonymously with pagination", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents?limit=3` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number; status?: string }[]; next_cursor: string | null };
    expect(body.items).toHaveLength(3);
    expect(body.next_cursor).toBeTruthy();
    expect(body.items[0]?.id).toBeGreaterThan(0);
  });

  it("filters by section, query, sort and field", async () => {
    const section = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents?section=movie` });
    const sectionBody = section.json() as { items: { section: { slug: string } }[] };
    expect(sectionBody.items.length).toBeGreaterThanOrEqual(4);
    expect(sectionBody.items.every((item) => item.section.slug === "movie")).toBe(true);

    const query = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents?q=dune` });
    const queryBody = query.json() as { items: { name: string }[] };
    expect(queryBody.items).toHaveLength(1);
    expect(queryBody.items[0]?.name).toContain("Dune");

    const sorted = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/torrents?sort=seeders_desc&limit=2`,
    });
    const sortedBody = sorted.json() as { items: { seeders: number }[] };
    expect(sortedBody.items[0]?.seeders).toBeGreaterThanOrEqual(sortedBody.items[1]?.seeders ?? 0);

    const field = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/torrents?field.resolution=2160p`,
    });
    const fieldBody = field.json() as { items: { meta: Record<string, unknown> }[] };
    expect(fieldBody.items.length).toBeGreaterThanOrEqual(2);
    expect(fieldBody.items.every((item) => item.meta.resolution === "2160p")).toBe(true);
  });

  it("returns torrent detail with files and related", async () => {
    const list = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents?limit=1` });
    const id = (list.json() as { items: { id: number }[] }).items[0]?.id ?? 0;

    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents/${String(id)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      info_hash: string;
      files: { path: string }[];
      related: unknown[];
    };
    expect(body.info_hash).toHaveLength(40);
    expect(body.files.length).toBeGreaterThan(0);
    expect(Array.isArray(body.related)).toBe(true);

    const missing = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents/999999` });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects downloads without a session", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/t/1/download" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});

describe("torrent upload + review", () => {
  it("uploads a torrent as pending and rejects duplicates", async () => {
    const torrent = makeTorrent("Test.Movie.2024.1080p.WEB-DL.x264-TEST");
    uploadedInfoHash = parseTorrent(torrent).infoHash;

    const payload = multipart(torrent, {
      section: "movie",
      category: "movie-film",
      name: "Test.Movie.2024.1080p.WEB-DL.x264-TEST",
      description: "上传测试",
      promo: "free",
      tags: "中字,测试",
      meta: JSON.stringify({ resolution: "1080p", source: "WEB-DL", codec: "x264" }),
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/torrents`,
      headers: uploadHeaders(user, payload.contentType),
      payload: payload.body,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: number; status: string };
    expect(body.status).toBe("pending");
    uploadedId = body.id;

    const duplicate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/torrents`,
      headers: uploadHeaders(user, payload.contentType),
      payload: payload.body,
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { code: string }).code).toBe("duplicate_info_hash");
  });

  it("rejects uploads without csrf and invalid torrents", async () => {
    const torrent = makeTorrent("Reject.Me.2024.1080p");
    const payload = multipart(torrent, { section: "movie", category: "movie-film" });

    const noCsrf = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/torrents`,
      headers: { cookie: user.cookieHeader, "content-type": payload.contentType },
      payload: payload.body,
    });
    expect(noCsrf.statusCode).toBe(403);

    const badPayload = multipart(Buffer.from("not a torrent"), {
      section: "movie",
      category: "movie-film",
    });
    const invalid = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/torrents`,
      headers: uploadHeaders(user, badPayload.contentType),
      payload: badPayload.body,
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { code: string }).code).toBe("invalid_torrent");
  });

  it("queues the pending torrent for staff only", async () => {
    const forbidden = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/review`,
      headers: { cookie: user.cookieHeader },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/review`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: number }[] };
    expect(body.items.some((item) => item.id === uploadedId)).toBe(true);
  });

  it("requires a reason for reject and approves pending torrents", async () => {
    const rejectWithoutReason = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/review/${String(uploadedId)}/reject`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(rejectWithoutReason.statusCode).toBe(400);
    expect((rejectWithoutReason.json() as { code: string }).code).toBe("reason_required");

    const approve = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/review/${String(uploadedId)}/approve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { status: string }).status).toBe("approved");

    const publicList = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/torrents?limit=50` });
    const ids = (publicList.json() as { items: { id: number }[] }).items.map((item) => item.id);
    expect(ids).toContain(uploadedId);

    const again = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/review/${String(uploadedId)}/approve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it("notifies the uploader and supports read-all", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications`,
      headers: { cookie: user.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { kind: string }[]; unread: number };
    expect(body.unread).toBe(1);
    expect(body.items[0]?.kind).toBe("review");

    const readAll = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/notifications/read-all`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
    });
    expect(readAll.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications`,
      headers: { cookie: user.cookieHeader },
    });
    expect((after.json() as { unread: number }).unread).toBe(0);
  });

  it("downloads the .torrent with a replaced announce but identical info bytes", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/t/${String(uploadedId)}/download`,
      headers: { cookie: admin.cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-bittorrent");
    expect(res.headers["cache-control"]).toContain("no-store");

    const rewritten = res.rawPayload;
    const parsed = parseTorrent(rewritten);
    expect(parsed.infoHash).toBe(uploadedInfoHash);

    const adminRow = await ctx.db
      .selectFrom("users")
      .select("passkey")
      .where("username", "=", "lightbringer")
      .executeTakeFirst();
    expect(parsed.announce).toBe(`http://localhost:31002/announce/${adminRow?.passkey ?? ""}`);
    expect(rewritten.includes(Buffer.from("announce-list"))).toBe(false);
  });
});
