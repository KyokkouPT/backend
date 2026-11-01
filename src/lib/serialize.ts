import type { Promo, TorrentSummary, UserSummary } from "@kyokkou/contracts";
import type { Selectable } from "kysely";
import type { ClassesTable, UsersTable } from "../db/types.js";

const PROMO_VALUES = new Set<string>(["free", "2x", "50", "30", "none"]);

export function ratioFor(uploaded: number, downloaded: number): number | null {
  if (downloaded <= 0) return null;
  return Math.round((uploaded / downloaded) * 100) / 100;
}

export function toUserSummary(
  user: Selectable<UsersTable>,
  classRow?: Selectable<ClassesTable> | null,
): UserSummary {
  const className = classRow
    ? {
        slug: classRow.slug,
        name: classRow.name,
        rank: Number(classRow.rank),
        badge: classRow.badge,
        color: classRow.color,
      }
    : {
        slug: user.class_key,
        name: user.class_key,
        rank: 0,
        badge: null,
        color: null,
      };

  return {
    id: Number(user.id),
    username: user.username,
    role: user.role,
    class_key: classRow?.slug ?? user.class_key,
    class: className,
    status: user.status,
    uploaded: Number(user.uploaded),
    downloaded: Number(user.downloaded),
    raw_uploaded: Number(user.raw_uploaded ?? 0),
    raw_downloaded: Number(user.raw_downloaded ?? 0),
    bonus: Number(user.bonus),
    ratio: ratioFor(Number(user.uploaded), Number(user.downloaded)),
    seedtime: Number(user.seedtime),
    created_at: Number(user.created_at),
  };
}

/** 头像色相：用户名稳定哈希到 0..359。 */
export function hueFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

export function parseMeta(json: string | null): Record<string, string | number | boolean> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const output: Record<string, string | number | boolean> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        output[key] = raw;
      }
    }
    return output;
  } catch {
    return {};
  }
}

export type TorrentJoinRow = {
  id: number;
  name: string;
  size: number;
  files_count: number;
  promo: string;
  seeders: number;
  leechers: number;
  completed: number;
  created_at: number;
  meta_json: string | null;
  section_slug: string;
  section_name: string;
  category_slug: string;
  category_name: string;
  uploader_id: number | null;
  uploader_name: string | null;
};

export function toTorrentSummary(
  row: TorrentJoinRow,
  tags: string[],
  owned: boolean,
): TorrentSummary {
  const promo: Promo = PROMO_VALUES.has(row.promo) ? (row.promo as Promo) : "none";

  return {
    id: Number(row.id),
    name: row.name,
    section: { slug: row.section_slug, name: row.section_name },
    category: { slug: row.category_slug, name: row.category_name },
    uploader:
      row.uploader_id !== null && row.uploader_name
        ? { id: Number(row.uploader_id), name: row.uploader_name, hue: hueFor(row.uploader_name) }
        : null,
    size: Number(row.size),
    files_count: Number(row.files_count),
    promo,
    seeders: Number(row.seeders),
    leechers: Number(row.leechers),
    completed: Number(row.completed),
    created_at: Number(row.created_at),
    tags,
    meta: parseMeta(row.meta_json),
    owned,
    download_url: `/t/${String(row.id)}/download`,
  };
}

export function numberCount(row: { count: number | string | null } | undefined): number {
  const raw = row?.count ?? 0;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(value) ? Number(value) : 0;
}
