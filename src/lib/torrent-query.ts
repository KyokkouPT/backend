import { sql } from "kysely";
import type { TorrentDetail, TorrentFile, TorrentSummary } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { toTorrentSummary } from "./serialize.js";

export type TorrentSort = "added_desc" | "seeders_desc" | "size_desc" | "completed_desc";

export type TorrentFilters = {
  limit: number;
  cursor?: number;
  section?: string;
  category?: string;
  promo?: string;
  uploader?: string;
  q?: string;
  sort: TorrentSort;
  since?: number;
  until?: number;
  fields: [string, string][];
};

type SummaryRow = {
  id: number;
  name: string;
  size: number;
  files_count: number;
  promo: string;
  zero_bonus: number;
  seeders: number;
  leechers: number;
  completed: number;
  created_at: number;
  meta_json: string | null;
  uploader_id: number | null;
  section_slug: string;
  section_name: string;
  category_slug: string;
  category_name: string;
  uploader_name: string | null;
};

const SUMMARY_COLUMNS = [
  "t.id as id",
  "t.name as name",
  "t.size as size",
  "t.files_count as files_count",
  "t.promo as promo",
  "t.zero_bonus as zero_bonus",
  "t.seeders as seeders",
  "t.leechers as leechers",
  "t.completed as completed",
  "t.created_at as created_at",
  "t.meta_json as meta_json",
  "t.uploader_id as uploader_id",
  "s.slug as section_slug",
  "s.name as section_name",
  "c.slug as category_slug",
  "c.name as category_name",
  "u.username as uploader_name",
] as const;

function toSummary(row: SummaryRow, tags: string[], viewerId: number | null): TorrentSummary {
  return toTorrentSummary(
    {
      id: Number(row.id),
      name: row.name,
      size: Number(row.size),
      files_count: Number(row.files_count),
      promo: row.promo,
      zero_bonus: Number(row.zero_bonus),
      seeders: Number(row.seeders),
      leechers: Number(row.leechers),
      completed: Number(row.completed),
      created_at: Number(row.created_at),
      meta_json: row.meta_json,
      section_slug: row.section_slug,
      section_name: row.section_name,
      category_slug: row.category_slug,
      category_name: row.category_name,
      uploader_id: row.uploader_id === null ? null : Number(row.uploader_id),
      uploader_name: row.uploader_name,
    },
    tags,
    viewerId !== null && row.uploader_id !== null && Number(row.uploader_id) === viewerId,
  );
}

async function tagsFor(db: Db, ids: number[]): Promise<Map<number, string[]>> {
  const output = new Map<number, string[]>();
  if (ids.length === 0) return output;

  const rows = await db
    .selectFrom("torrent_tags as tt")
    .innerJoin("tags as tg", "tg.id", "tt.tag_id")
    .select(["tt.torrent_id as torrent_id", "tg.name as name"])
    .where("tt.torrent_id", "in", ids)
    .execute();

  for (const row of rows) {
    const key = Number(row.torrent_id);
    const list = output.get(key) ?? [];
    list.push(row.name);
    output.set(key, list);
  }
  return output;
}

export async function listTorrents(
  db: Db,
  filters: TorrentFilters,
  viewerId: number | null,
): Promise<{ items: TorrentSummary[]; nextCursor: string | null }> {
  let query = db
    .selectFrom("torrents as t")
    .innerJoin("sections as s", "s.id", "t.section_id")
    .innerJoin("categories as c", "c.id", "t.category_id")
    .leftJoin("users as u", "u.id", "t.uploader_id")
    .select(SUMMARY_COLUMNS)
    .where("t.status", "=", "approved")
    .where("t.deleted_at", "is", null);

  if (filters.section) query = query.where("s.slug", "=", filters.section);
  if (filters.category) query = query.where("c.slug", "=", filters.category);
  if (filters.promo) query = query.where("t.promo", "=", filters.promo);
  if (filters.uploader) query = query.where("u.username", "=", filters.uploader);
  if (filters.q) {
    query = query.where(sql<boolean>`lower(t.name) like ${`%${filters.q.toLowerCase()}%`}`);
  }
  if (filters.since !== undefined) query = query.where("t.created_at", ">=", filters.since);
  if (filters.until !== undefined) query = query.where("t.created_at", "<=", filters.until);

  for (const [key, value] of filters.fields) {
    query = query.where(
      sql<boolean>`exists (select 1 from torrent_field_values fv where fv.torrent_id = t.id and fv.field_key = ${key} and fv.value_text = ${value})`,
    );
  }

  // cursor 只在 added_desc 下有效；其它排序返回单页，不复用 cursor。
  if (filters.sort === "added_desc" && filters.cursor !== undefined) {
    query = query.where("t.id", "<", filters.cursor);
  }

  switch (filters.sort) {
    case "seeders_desc":
      query = query.orderBy("t.seeders", "desc").orderBy("t.id", "desc");
      break;
    case "size_desc":
      query = query.orderBy("t.size", "desc").orderBy("t.id", "desc");
      break;
    case "completed_desc":
      query = query.orderBy("t.completed", "desc").orderBy("t.id", "desc");
      break;
    case "added_desc":
    default:
      query = query.orderBy("t.created_at", "desc").orderBy("t.id", "desc");
      break;
  }

  const rows = (await query.limit(filters.limit + 1).execute()) as unknown as SummaryRow[];
  const page = rows.slice(0, filters.limit);
  const tags = await tagsFor(db, page.map((row) => Number(row.id)));

  const items = page.map((row) => toSummary(row, tags.get(Number(row.id)) ?? [], viewerId));
  const nextCursor =
    filters.sort === "added_desc" && rows.length > filters.limit
      ? String(page[page.length - 1]?.id ?? "")
      : null;

  return { items, nextCursor: nextCursor && nextCursor.length > 0 ? nextCursor : null };
}

async function filesFor(db: Db, torrentId: number): Promise<TorrentFile[]> {
  const rows = await db
    .selectFrom("torrent_files")
    .select(["path", "size"])
    .where("torrent_id", "=", torrentId)
    .orderBy("id", "asc")
    .execute();

  return rows.map((row) => ({ path: row.path, size: Number(row.size) }));
}

export async function loadTorrentDetail(
  db: Db,
  id: number,
  viewerId: number | null,
): Promise<TorrentDetail | null> {
  const row = (await db
    .selectFrom("torrents as t")
    .innerJoin("sections as s", "s.id", "t.section_id")
    .innerJoin("categories as c", "c.id", "t.category_id")
    .leftJoin("users as u", "u.id", "t.uploader_id")
    .select([
      ...SUMMARY_COLUMNS,
      "t.description as description",
      "t.info_hash as info_hash",
      "t.section_id as section_id",
    ])
    .where("t.id", "=", id)
    .where("t.status", "=", "approved")
    .where("t.deleted_at", "is", null)
    .executeTakeFirst()) as unknown as
    | (SummaryRow & { description: string | null; info_hash: string; section_id: number })
    | undefined;

  if (!row) return null;

  const [tags, files, relatedRows] = await Promise.all([
    tagsFor(db, [id]),
    filesFor(db, id),
    db
      .selectFrom("torrents as t")
      .innerJoin("sections as s", "s.id", "t.section_id")
      .innerJoin("categories as c", "c.id", "t.category_id")
      .leftJoin("users as u", "u.id", "t.uploader_id")
      .select(SUMMARY_COLUMNS)
      .where("t.status", "=", "approved")
      .where("t.deleted_at", "is", null)
      .where("t.section_id", "=", Number(row.section_id))
      .where("t.id", "!=", id)
      .orderBy("t.created_at", "desc")
      .limit(6)
      .execute(),
  ]);

  const relatedTagMap = await tagsFor(
    db,
    relatedRows.map((related) => Number(related.id)),
  );

  const summary = toSummary(row, tags.get(id) ?? [], viewerId);

  return {
    ...summary,
    info_hash: row.info_hash,
    description: row.description,
    files,
    related: (relatedRows as unknown as SummaryRow[]).map((related) =>
      toSummary(related, relatedTagMap.get(Number(related.id)) ?? [], viewerId),
    ),
  };
}

export async function loadReviewQueue(db: Db): Promise<TorrentDetail[]> {
  const rows = (await db
    .selectFrom("torrents as t")
    .innerJoin("sections as s", "s.id", "t.section_id")
    .innerJoin("categories as c", "c.id", "t.category_id")
    .leftJoin("users as u", "u.id", "t.uploader_id")
    .select([...SUMMARY_COLUMNS, "t.description as description", "t.info_hash as info_hash"])
    .where("t.status", "=", "pending")
    .where("t.deleted_at", "is", null)
    .orderBy("t.created_at", "asc")
    .limit(50)
    .execute()) as unknown as (SummaryRow & { description: string | null; info_hash: string })[];

  const tagMap = await tagsFor(db, rows.map((row) => Number(row.id)));
  const ids = rows.map((row) => Number(row.id));

  const fileRows =
    ids.length > 0
      ? await db
          .selectFrom("torrent_files")
          .select(["torrent_id", "path", "size"])
          .where("torrent_id", "in", ids)
          .orderBy("id", "asc")
          .execute()
      : [];

  const filesByTorrent = new Map<number, TorrentFile[]>();
  for (const file of fileRows) {
    const key = Number(file.torrent_id);
    const list = filesByTorrent.get(key) ?? [];
    list.push({ path: file.path, size: Number(file.size) });
    filesByTorrent.set(key, list);
  }

  return rows.map((row) => ({
    ...toSummary(row, tagMap.get(Number(row.id)) ?? [], null),
    info_hash: row.info_hash,
    description: row.description,
    files: filesByTorrent.get(Number(row.id)) ?? [],
    related: [],
  }));
}
