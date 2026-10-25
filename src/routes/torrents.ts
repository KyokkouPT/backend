import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  sectionField,
  torrentDetail,
  torrentListResponse,
  uploadResponse,
  type TorrentDetail,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { requireAuth } from "../auth/csrf.js";
import { assertCsrf } from "../auth/csrf.js";
import { parseTorrent, rewriteAnnounce } from "../lib/bencode.js";
import { parseDownHashUid, verifyDownHash } from "../lib/downhash.js";
import { HttpProblem, badRequest, conflict, notFound, unauthorized } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { listTorrents, loadTorrentDetail, type TorrentFilters, type TorrentSort } from "../lib/torrent-query.js";
import { numberCount } from "../lib/serialize.js";

const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
const PROMO_VALUES = new Set(["free", "2x", "50", "30", "none"]);
const SORTS = new Set<TorrentSort>(["added_desc", "seeders_desc", "size_desc", "completed_desc"]);

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
  return undefined;
}

function firstNumber(value: unknown): number | undefined {
  const text = firstString(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseListQuery(query: Record<string, unknown>): TorrentFilters {
  const sortText = firstString(query.sort) ?? "added_desc";
  const sort: TorrentSort = SORTS.has(sortText as TorrentSort) ? (sortText as TorrentSort) : "added_desc";
  const limit = Math.min(50, Math.max(1, firstNumber(query.limit) ?? 20));

  const fields: [string, string][] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith("field.")) continue;
    const fieldKey = key.slice("field.".length);
    const value = firstString(raw);
    if (fieldKey.length > 0 && value !== undefined) fields.push([fieldKey, value]);
  }

  return {
    limit,
    sort,
    fields,
    ...(firstNumber(query.cursor) !== undefined ? { cursor: firstNumber(query.cursor) } : {}),
    ...(firstString(query.section) ? { section: firstString(query.section) } : {}),
    ...(firstString(query.category) ? { category: firstString(query.category) } : {}),
    ...(firstString(query.promo) ? { promo: firstString(query.promo) } : {}),
    ...(firstString(query.uploader) ? { uploader: firstString(query.uploader) } : {}),
    ...(firstString(query.q) ? { q: firstString(query.q) } : {}),
    ...(firstNumber(query.since) !== undefined ? { since: firstNumber(query.since) } : {}),
    ...(firstNumber(query.until) !== undefined ? { until: firstNumber(query.until) } : {}),
  };
}

async function ensureTagIds(db: Db, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim().slice(0, 64);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);

    const slug = name.toLowerCase().replace(/\s+/g, "-").slice(0, 64);
    let row = await db.selectFrom("tags").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!row) {
      await db.insertInto("tags").values({ slug, name }).execute();
      row = await db.selectFrom("tags").select("id").where("slug", "=", slug).executeTakeFirst();
    }
    if (row) ids.push(Number(row.id));
    if (ids.length >= 8) break;
  }

  return ids;
}

export function torrentRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;

    app.get(`${API_PREFIX}/torrents`, async (request) => {
      const filters = parseListQuery(request.query as Record<string, unknown>);
      const viewerId = request.auth ? Number(request.auth.user.id) : null;
      const result = await listTorrents(db, filters, viewerId);
      return torrentListResponse.parse({ items: result.items, next_cursor: result.nextCursor });
    });

    app.get(`${API_PREFIX}/torrents/:id`, async (request) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) throw notFound("torrent_not_found", "种子不存在");

      const viewerId = request.auth ? Number(request.auth.user.id) : null;
      const detail = await loadTorrentDetail(db, id, viewerId);
      if (!detail) throw notFound("torrent_not_found", "种子不存在");

      return torrentDetail.parse(detail);
    });

    app.post(`${API_PREFIX}/torrents`, async (request, reply) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);

      let fileBuffer: Buffer | null = null;
      const fields: Record<string, string> = {};

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || fileBuffer) {
            await part.toBuffer();
            continue;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
          if (part.file.truncated) {
            throw new HttpProblem(413, "upload_too_large", "种子文件不能超过 5MB");
          }
          fileBuffer = Buffer.concat(chunks);
        } else {
          fields[part.fieldname] = String(part.value ?? "");
        }
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        throw badRequest("file_required", "请选择 .torrent 文件");
      }
      if (fileBuffer.length > MAX_TORRENT_BYTES) {
        throw new HttpProblem(413, "upload_too_large", "种子文件不能超过 5MB");
      }

      let parsed;
      try {
        parsed = parseTorrent(fileBuffer);
      } catch {
        throw badRequest("invalid_torrent", "无法解析 .torrent 文件");
      }

      const duplicate = await db
        .selectFrom("torrents")
        .select("id")
        .where("info_hash", "=", parsed.infoHash)
        .executeTakeFirst();
      if (duplicate) throw conflict("duplicate_info_hash", "该种子已经存在");

      const sectionSlug = fields.section;
      const categorySlug = fields.category;
      if (!sectionSlug || !categorySlug) {
        throw badRequest("section_required", "请选择分区与分类");
      }

      const section = await db
        .selectFrom("sections")
        .selectAll()
        .where("slug", "=", sectionSlug)
        .executeTakeFirst();
      const category = section
        ? await db
            .selectFrom("categories")
            .select("id")
            .where("section_id", "=", section.id)
            .where("slug", "=", categorySlug)
            .executeTakeFirst()
        : undefined;
      if (!section || !category) throw badRequest("invalid_category", "分区或分类不存在");

      let sectionConfig: { fields?: unknown } = {};
      try {
        const parsedConfig: unknown = JSON.parse(section.config_json);
        if (typeof parsedConfig === "object" && parsedConfig !== null) {
          sectionConfig = parsedConfig as { fields?: unknown };
        }
      } catch {
        /* 空配置 */
      }
      const fieldDefsResult = sectionField.array().safeParse(sectionConfig.fields ?? []);
      const fieldDefs = fieldDefsResult.success ? fieldDefsResult.data : [];

      let meta: Record<string, string | number | boolean> = {};
      if (fields.meta) {
        try {
          const parsedMeta: unknown = JSON.parse(fields.meta);
          if (typeof parsedMeta !== "object" || parsedMeta === null || Array.isArray(parsedMeta)) {
            throw new Error("meta must be an object");
          }
          for (const [key, value] of Object.entries(parsedMeta)) {
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
              meta[key] = value;
            }
          }
        } catch {
          throw badRequest("invalid_meta", "字段信息不是合法的 JSON 对象");
        }
      }

      for (const def of fieldDefs.filter((item) => item.required)) {
        const value = meta[def.key];
        if (value === undefined || value === "") {
          throw new HttpProblem(400, "field_required", `请填写「${def.label}」`, [
            { path: `meta.${def.key}`, message: "必填字段" },
          ]);
        }
      }

      const promo = fields.promo && PROMO_VALUES.has(fields.promo) ? fields.promo : "none";
      const name = (fields.name?.trim() || parsed.name).slice(0, 255);
      const description = fields.description?.trim() ? fields.description.trim() : null;

      const settings = await loadSettings(db);
      const published = await db
        .selectFrom("torrents")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("uploader_id", "=", Number(auth.user.id))
        .where("status", "=", "approved")
        .where("deleted_at", "is", null)
        .executeTakeFirst();

      const trustedByRole = auth.user.role === "admin" || auth.user.role === "moderator";
      const trustedByCount =
        settings.review.auto_approve_trusted &&
        numberCount(published) >= settings.review.trusted_min_approved;
      const status = trustedByRole || trustedByCount ? "approved" : "pending";
      const now = Date.now();

      await db
        .insertInto("torrents")
        .values({
          info_hash: parsed.infoHash,
          name,
          section_id: Number(section.id),
          category_id: Number(category.id),
          uploader_id: Number(auth.user.id),
          size: parsed.totalSize,
          files_count: parsed.files.length,
          status,
          promo,
          seeders: 0,
          leechers: 0,
          completed: 0,
          description,
          meta_json: JSON.stringify(meta),
          torrent_blob: fileBuffer,
          created_at: now,
          approved_at: status === "approved" ? now : null,
          deleted_at: null,
        })
        .execute();

      const inserted = await db
        .selectFrom("torrents")
        .select("id")
        .where("info_hash", "=", parsed.infoHash)
        .executeTakeFirstOrThrow();
      const torrentId = Number(inserted.id);

      if (parsed.files.length > 0) {
        await db
          .insertInto("torrent_files")
          .values(parsed.files.map((file) => ({ torrent_id: torrentId, path: file.path, size: file.size })))
          .execute();
      }

      const fieldKeys = new Set(fieldDefs.map((def) => def.key));
      const fieldValues = Object.entries(meta)
        .filter(([key]) => fieldKeys.has(key))
        .map(([key, value]) => ({
          torrent_id: torrentId,
          field_key: key,
          value_text: String(value).slice(0, 255),
        }));
      if (fieldValues.length > 0) {
        await db.insertInto("torrent_field_values").values(fieldValues).execute();
      }

      const tagNames = (fields.tags ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const tagIds = await ensureTagIds(db, tagNames);
      if (tagIds.length > 0) {
        await db
          .insertInto("torrent_tags")
          .values(tagIds.map((tagId) => ({ torrent_id: torrentId, tag_id: tagId })))
          .execute();
      }

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "torrent.upload",
          target_type: "torrent",
          target_id: String(torrentId),
          detail_json: JSON.stringify({ info_hash: parsed.infoHash, status }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      return reply.status(201).send(
        uploadResponse.parse({
          id: torrentId,
          status,
          message: status === "approved" ? "已通过审核并公开" : "已提交，等待审核",
        }),
      );
    });

    app.get("/t/:id/download", async (request, reply) => {
      const id = Number((request.params as { id: string }).id);

      // Cookie 或短期 downhash 二选一：RSS 客户端没有 session。
      let user = request.auth?.user ?? null;
      if (!user) {
        const query = request.query as { downhash?: string };
        if (typeof query.downhash === "string") {
          const uid = parseDownHashUid(query.downhash);
          if (uid !== null) {
            const candidate = await db
              .selectFrom("users")
              .selectAll()
              .where("id", "=", uid)
              .where("status", "=", "active")
              .executeTakeFirst();
            if (
              candidate &&
              verifyDownHash(config.sessionSecret, candidate.passkey, query.downhash, { uid, tid: id })
            ) {
              user = candidate;
            }
          }
        }
      }
      if (!user) throw unauthorized();

      const row = await db
        .selectFrom("torrents")
        .select(["id", "name", "torrent_blob", "status", "deleted_at"])
        .where("id", "=", id)
        .executeTakeFirst();

      if (!row || row.status !== "approved" || row.deleted_at !== null) {
        throw notFound("torrent_not_found", "种子不存在");
      }
      if (!row.torrent_blob) {
        throw notFound("torrent_file_missing", "该种子没有可下载的 .torrent 文件");
      }

      let rewritten: Buffer;
      try {
        rewritten = rewriteAnnounce(
          Buffer.from(row.torrent_blob),
          `${config.trackerBaseUrl}/announce/${user.passkey}`,
        );
      } catch {
        throw new HttpProblem(500, "torrent_rewrite_failed", "种子文件解析失败");
      }

      const asciiName =
        row.name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\/]/g, "_").slice(0, 120) || "torrent";

      reply.header("content-type", "application/x-bittorrent");
      reply.header(
        "content-disposition",
        `attachment; filename="${asciiName}.torrent"; filename*=UTF-8''${encodeURIComponent(`${row.name}.torrent`)}`,
      );
      reply.header("cache-control", "no-store");

      return reply.send(rewritten);
    });
  };
}

export type { TorrentDetail };
