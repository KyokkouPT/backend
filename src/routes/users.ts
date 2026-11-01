import type { FastifyPluginAsync } from "fastify";
import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import {
  API_PREFIX,
  PERMISSIONS,
  btClientsResponse,
  userProfile,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { classBriefOf, loadClassById } from "../lib/classes.js";
import { notFound } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { numberCount, ratioFor } from "../lib/serialize.js";
import { listTorrents } from "../lib/torrent-query.js";
import { normalizeUsername } from "../lib/username.js";

const DNS_TTL_MS = 5 * 60 * 1000;
const DNS_TIMEOUT_MS = 800;
const reverseCache = new Map<string, { value: string | null; expiresAt: number }>();

async function reverseDns(ip: string): Promise<string | null> {
  const cached = reverseCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const lookup = dns
    .reverse(ip)
    .then((names) => names[0] ?? null)
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), DNS_TIMEOUT_MS));
  const value = await Promise.race([lookup, timeout]);
  reverseCache.set(ip, { value, expiresAt: Date.now() + DNS_TTL_MS });
  return value;
}

type ClientGroup = {
  peerIdHex: string;
  ipv4: Set<string>;
  ipv6: Set<string>;
  firstIp: string | null;
  startedAt: number;
  lastSeenAt: number;
  seeding: number;
  leeching: number;
};

export function userRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    async function loadPublicProfile(userId: number) {
      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", userId)
        .executeTakeFirst();
      if (!user || user.status !== "active") throw notFound("user_not_found", "用户不存在");

      const preferences = await db
        .selectFrom("user_preferences")
        .selectAll()
        .where("user_id", "=", user.id)
        .executeTakeFirst();

      const publishedVisible = preferences ? Number(preferences.public_published) === 1 : true;
      const seedingVisible = preferences ? Number(preferences.public_seeding) === 1 : true;

      const publishedCount = await db
        .selectFrom("torrents")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("uploader_id", "=", user.id)
        .where("status", "=", "approved")
        .where("deleted_at", "is", null)
        .executeTakeFirst();

      const seedingCount = seedingVisible
        ? numberCount(
            await db
              .selectFrom("snatches")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where("user_id", "=", user.id)
              .where("status", "=", "seeding")
              .executeTakeFirst(),
          )
        : null;

      const published = publishedVisible
        ? (
            await listTorrents(
              db,
              {
                limit: 10,
                sort: "added_desc",
                fields: [],
                uploader: user.username,
              },
              null,
            )
          ).items
        : [];

      const classRow =
        user.class_id === null ? null : await loadClassById(db, Number(user.class_id));

      return userProfile.parse({
        name: user.username,
        role: user.role,
        class_key: classRow?.slug ?? user.class_key,
        class: classBriefOf(classRow, user.class_key, user.class_key),
        joined_at: Number(user.created_at),
        uploaded: Number(user.uploaded),
        downloaded: Number(user.downloaded),
        raw_uploaded: Number(user.raw_uploaded ?? 0),
        raw_downloaded: Number(user.raw_downloaded ?? 0),
        ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
        seedtime: Number(user.seedtime),
        bonus: Number(user.bonus),
        published_count: numberCount(publishedCount),
        seeding_count: seedingCount,
        published_visible: publishedVisible,
        custom_title: user.custom_title ?? null,
        published,
      });
    }

    app.get(`${API_PREFIX}/users/:name`, async (request) => {
      const name = normalizeUsername((request.params as { name: string }).name);
      const user = await db
        .selectFrom("users")
        .select("id")
        .where("username", "=", name)
        .executeTakeFirst();
      if (!user) throw notFound("user_not_found", "用户不存在");
      return loadPublicProfile(Number(user.id));
    });

    app.get(`${API_PREFIX}/users/id/:id`, async (request) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) throw notFound("user_not_found", "用户不存在");
      return loadPublicProfile(id);
    });

    app.get(`${API_PREFIX}/users/:id/clients`, async (request) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) throw notFound("user_not_found", "用户不存在");

      const user = await db
        .selectFrom("users")
        .select(["id", "status"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!user || user.status !== "active") throw notFound("user_not_found", "用户不存在");

      const preferences = await db
        .selectFrom("user_preferences")
        .select("public_seeding")
        .where("user_id", "=", id)
        .executeTakeFirst();
      const publicSeeding = preferences ? Number(preferences.public_seeding) === 1 : true;
      const viewer = request.auth;
      const canSee =
        Number(viewer?.user.id ?? 0) === id ||
        Boolean(viewer?.permissions.includes(PERMISSIONS.staffUsers)) ||
        publicSeeding;
      if (!canSee) return btClientsResponse.parse({ items: [], hidden: true });

      const settings = await loadSettings(db);
      const cutoff = Date.now() - settings.tracker.peer_ttl * 1000;
      const rows = await db
        .selectFrom("peers")
        .select(["peer_id_hex", "ip", "port", "seeder", "created_at", "last_seen"])
        .where("user_id", "=", id)
        .where("last_seen", ">=", cutoff)
        .orderBy("last_seen", "desc")
        .execute();

      const groups = new Map<string, ClientGroup>();
      for (const row of rows) {
        let group = groups.get(row.peer_id_hex);
        if (!group) {
          group = {
            peerIdHex: row.peer_id_hex,
            ipv4: new Set(),
            ipv6: new Set(),
            firstIp: null,
            startedAt: Number(row.created_at),
            lastSeenAt: Number(row.last_seen),
            seeding: 0,
            leeching: 0,
          };
          groups.set(row.peer_id_hex, group);
        }
        group.startedAt = Math.min(group.startedAt, Number(row.created_at));
        group.lastSeenAt = Math.max(group.lastSeenAt, Number(row.last_seen));
        if (Number(row.seeder) === 1) group.seeding += 1;
        else group.leeching += 1;

        const family = isIP(row.ip);
        if (family === 4) group.ipv4.add(`${row.ip}:${String(row.port)}`);
        if (family === 6) group.ipv6.add(`[${row.ip}]:${String(row.port)}`);
        group.firstIp ??= row.ip;
      }

      const items = await Promise.all(
        [...groups.values()].map(async (group) => {
          const peerId = Buffer.from(group.peerIdHex, "hex").toString("ascii");
          const clientCode = peerId.replace(/[^\x20-\x7e]/g, "").slice(0, 8) || null;
          const reverse = group.firstIp ? await reverseDns(group.firstIp) : null;
          const has4 = group.ipv4.size > 0;
          const has6 = group.ipv6.size > 0;
          return {
            client_code: clientCode,
            ipv4: has4 ? [...group.ipv4].join(", ") : null,
            ipv6: has6 ? [...group.ipv6].join(", ") : null,
            reverse_dns: reverse,
            features: has4 && has6 ? ("4&6" as const) : has6 ? ("6" as const) : ("4" as const),
            seeding: group.seeding,
            leeching: group.leeching,
            started_at: group.startedAt,
            last_seen_at: group.lastSeenAt,
          };
        }),
      );

      return btClientsResponse.parse({ items, hidden: false });
    });
  };
}
