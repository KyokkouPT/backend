import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { encodeBencode, encodeBytes } from "../lib/bencode.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { loadSettings } from "../lib/settings.js";
import { recordAnnounce } from "../tracker/persist.js";
import { bufferToAscii, parseRawQuery } from "../tracker/raw-query.js";
import {
  compactIPv4,
  compactIPv6,
  countPeers,
  listPeers,
  normalizeIp,
  peerKey,
  removePeer,
  upsertPeer,
} from "../tracker/registry.js";

function failure(reason: string): Buffer {
  return encodeBencode({ "failure reason": reason });
}

function asInt(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function trackerRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    /** GET /announce、/announce/:passkey */
    const announce = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      reply.type("text/plain");

      const query = parseRawQuery(request.raw.url);
      const params = request.params as { passkey?: string };
      const passkey = params.passkey ?? bufferToAscii(query.get("passkey")?.[0]);
      const infoHashBuffer = query.get("info_hash")?.[0];
      const peerIdBuffer = query.get("peer_id")?.[0];

      if (!infoHashBuffer || infoHashBuffer.length !== 20) {
        return reply.send(failure("invalid info_hash"));
      }
      if (!peerIdBuffer || peerIdBuffer.length !== 20) {
        return reply.send(failure("invalid peer_id"));
      }
      if (!passkey) return reply.send(failure("missing passkey"));

      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("passkey", "=", passkey)
        .executeTakeFirst();
      if (!user || user.status !== "active") return reply.send(failure("invalid passkey"));

      const infoHashHex = infoHashBuffer.toString("hex");
      const torrent = await db
        .selectFrom("torrents")
        .selectAll()
        .where("info_hash", "=", infoHashHex)
        .where("status", "=", "approved")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!torrent) return reply.send(failure("torrent not found or not approved"));

      const port = asInt(bufferToAscii(query.get("port")?.[0]));
      if (port <= 0 || port > 65535) return reply.send(failure("invalid port"));

      const uploaded = asInt(bufferToAscii(query.get("uploaded")?.[0]));
      const downloaded = asInt(bufferToAscii(query.get("downloaded")?.[0]));
      const left = asInt(bufferToAscii(query.get("left")?.[0]));
      const eventText = bufferToAscii(query.get("event")?.[0]).toLowerCase();
      const event = ["started", "stopped", "completed"].includes(eventText) ? eventText : "";

      const requestedIp = bufferToAscii(query.get("ip")?.[0]);
      const ip = requestedIp && isIP(requestedIp) !== 0 ? requestedIp : normalizeIp(request.ip);
      const peerIdHex = peerIdBuffer.toString("hex");
      const key = peerKey(Number(user.id), peerIdHex);
      const now = Date.now();

      if (event === "stopped") {
        removePeer(infoHashHex, key);
      } else {
        upsertPeer(infoHashHex, {
          peerIdHex,
          ip,
          port,
          userId: Number(user.id),
          lastSeen: now,
          left,
          seeder: left === 0,
        });
      }

      await recordAnnounce(db, {
        user,
        torrent,
        uploaded,
        downloaded,
        left,
        event,
        promo: torrent.promo,
      });

      const settings = await loadSettings(db);
      const counts = countPeers(infoHashHex);

      await db
        .updateTable("torrents")
        .set({ seeders: counts.seeders, leechers: counts.leechers })
        .where("id", "=", torrent.id)
        .execute();

      const fresh = await db
        .selectFrom("torrents")
        .select(["completed"])
        .where("id", "=", torrent.id)
        .executeTakeFirst();

      const others = listPeers(infoHashHex).filter(
        (peer) => !(peer.userId === Number(user.id) && peer.peerIdHex === peerIdHex),
      );
      const numwant = Math.min(
        asInt(bufferToAscii(query.get("numwant")?.[0])) || 50,
        settings.tracker.max_peers,
      );
      const selected = others.slice(0, numwant);
      const peers4 = compactIPv4(selected);
      const peers6 = settings.tracker.allow_ipv6 ? compactIPv6(selected) : Buffer.alloc(0);

      const body = encodeBencode({
        complete: counts.seeders,
        incomplete: counts.leechers,
        downloaded: Number(fresh?.completed ?? torrent.completed),
        interval: settings.tracker.announce_interval,
        "min interval": settings.tracker.min_interval,
        peers: peers4,
        ...(settings.tracker.allow_ipv6 ? { peers6 } : {}),
      });

      return reply.send(body);
    };

    /** GET /scrape、/scrape/:passkey */
    const scrape = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      reply.type("text/plain");

      const query = parseRawQuery(request.raw.url);
      const params = request.params as { passkey?: string };
      const passkey = params.passkey ?? bufferToAscii(query.get("passkey")?.[0]);
      if (!passkey) return reply.send(failure("missing passkey"));

      const user = await db
        .selectFrom("users")
        .select(["id", "status"])
        .where("passkey", "=", passkey)
        .executeTakeFirst();
      if (!user || user.status !== "active") return reply.send(failure("invalid passkey"));

      const requestedHashes = query.get("info_hash") ?? [];
      const hashes =
        requestedHashes.length > 0
          ? requestedHashes
          : (
              await db
                .selectFrom("torrents")
                .select("info_hash")
                .where("status", "=", "approved")
                .where("deleted_at", "is", null)
                .limit(50)
                .execute()
            ).map((row) => Buffer.from(row.info_hash, "hex"));

      const parts: Buffer[] = [Buffer.from("d5:filesd", "ascii")];

      for (const hash of hashes) {
        if (hash.length !== 20) continue;
        const hex = hash.toString("hex");
        const torrent = await db
          .selectFrom("torrents")
          .select(["completed", "status", "deleted_at"])
          .where("info_hash", "=", hex)
          .executeTakeFirst();
        if (!torrent || torrent.status !== "approved" || torrent.deleted_at !== null) continue;

        const counts = countPeers(hex);
        parts.push(
          encodeBytes(hash),
          encodeBencode({
            complete: counts.seeders,
            incomplete: counts.leechers,
            downloaded: Number(torrent.completed),
          }),
        );
      }

      parts.push(Buffer.from("ee", "ascii"));
      return reply.send(Buffer.concat(parts));
    };

    app.get("/announce", announce);
    app.get("/announce/:passkey", announce);
    app.get("/scrape", scrape);
    app.get("/scrape/:passkey", scrape);
  };
}
