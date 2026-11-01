import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeTorrent } from "../src/lib/bencode.js";
import { settleHnr } from "../src/lib/hnr.js";
import { clearPeersForTests, prunePeers } from "../src/tracker/peer-store.js";
import { createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let axuePasskey = "";
let lightbringerPasskey = "";

const ZONE_HASH = "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";

function percentEncode(buffer: Buffer): string {
  return [...buffer].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
}

function peerId(label: string): string {
  return `PEER${label.padEnd(16, "0").slice(0, 16)}`;
}

function announcePath(
  passkey: string,
  infoHashHex: string,
  peerLabel: string,
  options: { uploaded?: number; downloaded?: number; left?: number; event?: string; ip?: string } = {},
): string {
  const params = [
    `info_hash=${percentEncode(Buffer.from(infoHashHex, "hex"))}`,
    `peer_id=${percentEncode(Buffer.from(peerId(peerLabel), "ascii"))}`,
    "port=6881",
    `uploaded=${String(options.uploaded ?? 0)}`,
    `downloaded=${String(options.downloaded ?? 0)}`,
    `left=${String(options.left ?? 0)}`,
    "compact=1",
    `event=${options.event ?? "started"}`,
  ];
  if (options.ip) params.push(`ip=${encodeURIComponent(options.ip)}`);
  return `/announce/${passkey}?${params.join("&")}`;
}

async function userRow(username: string) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  ctx = await createTestContext();
  await clearPeersForTests(ctx.db);
  axuePasskey = (await userRow("阿雪")).passkey;
  lightbringerPasskey = (await userRow("lightbringer")).passkey;
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("tracker announce", () => {
  it("registers a peer and persists the snatch", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-1", { uploaded: 1000, left: 0 }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const node = decodeTorrent(res.rawPayload);
    expect(node.kind).toBe("dict");
    if (node.kind === "dict") {
      const keys = node.entries.map((entry) => entry.key);
      expect(keys).toContain("interval");
      expect(keys).toContain("complete");
      expect(keys).toContain("peers");
    }

    const snatch = await ctx.db
      .selectFrom("snatches as sn")
      .innerJoin("users as u", "u.id", "sn.user_id")
      .innerJoin("torrents as t", "t.id", "sn.torrent_id")
      .select(["sn.uploaded", "sn.status"])
      .where("u.username", "=", "阿雪")
      .where("t.info_hash", "=", ZONE_HASH)
      .executeTakeFirst();

    expect(snatch).toBeTruthy();
    expect(Number(snatch?.uploaded)).toBe(1000);
    expect(snatch?.status).toBe("seeding");
  });

  it("never decreases persisted counters", async () => {
    const before = await userRow("阿雪");

    await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-2", { uploaded: 500, left: 0 }),
    });
    const afterSmall = await userRow("阿雪");
    expect(Number(afterSmall.uploaded)).toBe(Number(before.uploaded));

    await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-3", { uploaded: 3000, left: 0 }),
    });
    const afterBig = await userRow("阿雪");
    expect(Number(afterBig.uploaded) - Number(before.uploaded)).toBe(2000);

    const snatch = await ctx.db
      .selectFrom("snatches as sn")
      .innerJoin("torrents as t", "t.id", "sn.torrent_id")
      .select("sn.uploaded")
      .where("t.info_hash", "=", ZONE_HASH)
      .where("sn.user_id", "=", Number((await userRow("阿雪")).id))
      .executeTakeFirstOrThrow();
    expect(Number(snatch.uploaded)).toBe(3000);
  });

  it("counts event=completed only once and creates an H&R obligation", async () => {
    const torrentBefore = await ctx.db
      .selectFrom("torrents")
      .select("completed")
      .where("info_hash", "=", ZONE_HASH)
      .executeTakeFirstOrThrow();

    const downloaded = 20 * 1024 ** 3;
    await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-4", {
        uploaded: 3000,
        downloaded,
        left: 0,
        event: "completed",
      }),
    });
    await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-5", {
        uploaded: 3000,
        downloaded,
        left: 0,
        event: "completed",
      }),
    });

    const torrentAfter = await ctx.db
      .selectFrom("torrents")
      .select("completed")
      .where("info_hash", "=", ZONE_HASH)
      .executeTakeFirstOrThrow();
    expect(Number(torrentAfter.completed) - Number(torrentBefore.completed)).toBe(1);

    const obligation = await ctx.db
      .selectFrom("hnr_obligations as h")
      .innerJoin("users as u", "u.id", "h.user_id")
      .innerJoin("torrents as t", "t.id", "h.torrent_id")
      .select(["h.status", "h.required_seconds", "h.seeded_seconds"])
      .where("u.username", "=", "阿雪")
      .where("t.info_hash", "=", ZONE_HASH)
      .executeTakeFirst();

    expect(obligation).toBeTruthy();

    const rawRow = await ctx.db
      .selectFrom("users")
      .select(["raw_uploaded", "raw_downloaded"])
      .where("username", "=", "阿雪")
      .executeTakeFirstOrThrow();
    expect(Number(rawRow.raw_uploaded)).toBeGreaterThanOrEqual(3000);
    expect(Number(rawRow.raw_downloaded)).toBeGreaterThanOrEqual(downloaded);
    expect(obligation?.status).toBe("inspecting");

    await ctx.db
      .updateTable("hnr_obligations")
      .set({ seeded_seconds: 999_999 })
      .where("user_id", "=", Number((await userRow("阿雪")).id))
      .execute();

    const changed = await settleHnr(ctx.db);
    expect(changed).toBeGreaterThanOrEqual(1);

    const settled = await ctx.db
      .selectFrom("hnr_obligations as h")
      .innerJoin("users as u", "u.id", "h.user_id")
      .select("h.status")
      .where("u.username", "=", "阿雪")
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe("reached");
  });

  it("returns compact IPv4 peers and excludes the caller", async () => {
    await ctx.app.inject({
      method: "GET",
      url: announcePath(lightbringerPasskey, ZONE_HASH, "light-1", { left: 1 }),
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-6", { left: 0 }),
    });

    const node = decodeTorrent(res.rawPayload);
    if (node.kind !== "dict") throw new Error("expected dict");
    const peers = node.entries.find((entry) => entry.key === "peers")?.value;
    expect(peers?.kind).toBe("bytes");
    if (peers?.kind === "bytes") {
      expect(peers.value.length % 6).toBe(0);
      expect(peers.value.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("returns peers6 when allow_ipv6 and an IPv6 peer announces", async () => {
    await ctx.app.inject({
      method: "GET",
      url: announcePath(lightbringerPasskey, ZONE_HASH, "light-2", {
        left: 1,
        ip: "2001:db8::1",
      }),
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: announcePath(axuePasskey, ZONE_HASH, "axue-7", { left: 0 }),
    });

    const node = decodeTorrent(res.rawPayload);
    if (node.kind !== "dict") throw new Error("expected dict");
    const peers6 = node.entries.find((entry) => entry.key === "peers6")?.value;
    expect(peers6).toBeTruthy();
    if (peers6?.kind === "bytes") {
      expect(peers6.value.length % 18).toBe(0);
      expect(peers6.value.length).toBeGreaterThanOrEqual(18);
    }
  });

  it("fails with a bencoded failure reason on bad input", async () => {
    const badHash = await ctx.app.inject({
      method: "GET",
      url: `/announce/${axuePasskey}?info_hash=%01%02&peer_id=${percentEncode(Buffer.from(peerId("bad"), "ascii"))}&port=6881`,
    });
    expect(badHash.statusCode).toBe(200);
    expect(badHash.rawPayload.toString("utf8")).toContain("invalid info_hash");

    const badPasskey = await ctx.app.inject({
      method: "GET",
      url: announcePath("wrong-passkey", ZONE_HASH, "bad-2", {}),
    });
    expect(badPasskey.rawPayload.toString("utf8")).toContain("invalid passkey");
  });

  it("scrapes using raw 20-byte info_hash keys", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/scrape/${axuePasskey}?info_hash=${percentEncode(Buffer.from(ZONE_HASH, "hex"))}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.includes(Buffer.from(ZONE_HASH, "hex"))).toBe(true);
    expect(res.rawPayload.toString("latin1")).toContain("complete");
    expect(res.rawPayload.toString("latin1")).toContain("incomplete");
  });

  it("prunes stale peers by TTL", async () => {
    const removed = await prunePeers(ctx.db, -1);
    expect(removed).toBeGreaterThan(0);
  });
});

describe("downhash", () => {
  it("signs and verifies with passkey-derived key", async () => {
    const { signDownHash, verifyDownHash } = await import("../src/lib/downhash.js");
    const token = signDownHash("test-session-secret-at-least-32-bytes-long", lightbringerPasskey, 2, 1);
    expect(verifyDownHash("test-session-secret-at-least-32-bytes-long", lightbringerPasskey, token, { uid: 2, tid: 1 })).toBe(true);
    expect(verifyDownHash("test-session-secret-at-least-32-bytes-long", lightbringerPasskey, token, { uid: 2, tid: 2 })).toBe(false);
    expect(verifyDownHash("test-session-secret-at-least-32-bytes-long", "other-passkey", token, { uid: 2, tid: 1 })).toBe(false);
    const [uidPart, jwt] = token.split("|");
    const [header, payload, signature] = (jwt ?? "").split(".");
    const tamperedSignature = `${signature?.[0] === "A" ? "B" : "A"}${(signature ?? "").slice(1)}`;
    const tampered = `${uidPart ?? ""}|${header ?? ""}.${payload ?? ""}.${tamperedSignature}`;
    expect(verifyDownHash("test-session-secret-at-least-32-bytes-long", lightbringerPasskey, tampered, { uid: 2, tid: 1 })).toBe(false);
  });
});
