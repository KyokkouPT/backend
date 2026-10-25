import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  announcement as announcementSchema,
  bootstrap,
  homeResponse,
  rulesResponse,
  sectionField as sectionFieldSchema,
  type Announcement,
  type BootstrapCounts,
  type HomeStats,
  type NavGroup,
  type PromoEvent,
  type Section,
  type SiteIdentity,
  type SiteNav,
  type TorrentSummary,
} from "@kyokkou/contracts";
import type { Settings } from "@kyokkou/config";
import { PERMISSIONS } from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import { APP_VERSION } from "../version.js";
import type { Db } from "../db/db.js";
import { permissionsFor } from "../auth/permissions.js";
import { unreadNotificationCount } from "../lib/notifications.js";
import { loadSettings } from "../lib/settings.js";
import { numberCount, toTorrentSummary, toUserSummary, type TorrentJoinRow } from "../lib/serialize.js";

/** H&R 策略表在 003 迁移；此阶段返回文档默认策略，后续改读数据库。 */
const DEFAULT_HNR_POLICY = {
  enabled: true,
  seed_seconds: 72 * 3600,
  deadline_days: 14,
};

function toSiteIdentity(settings: Settings, version: string): SiteIdentity {
  const year = new Date().getFullYear();

  return {
    name: settings.site.name,
    tagline: settings.site.tagline,
    locale: settings.site.locale,
    version,
    theme: { default: "polar" },
    modules: {
      tracker: true,
      bonus: settings.economy.bonus_enabled,
      exchange: settings.economy.exchange_enabled,
      invites: settings.registration.invite_registration_enabled,
      requests: false,
    },
    registration: settings.registration,
    footer: {
      copyright: `© ${year} ${settings.site.name}`,
      icp: null,
      disclaimer: "本站仅索引 BitTorrent 元数据，不存储任何资源文件；资源由用户自愿共享。",
      status: "服务正常",
    },
  };
}

/**
 * 导航由后端按“已实现页面”生成，避免前端出现死链。
 * 图标是字符串 key，前端映射到 lucide 组件。
 */
function buildNav(options: { loggedIn: boolean; canReview: boolean }): SiteNav {
  const groups: NavGroup[] = [
    {
      items: [
        { key: "home", href: "/", label: "首页", icon: "home", exact: true },
        { key: "browse", href: "/browse", label: "浏览", icon: "compass" },
        { key: "rules", href: "/rules", label: "规则", icon: "book-open" },
      ],
    },
  ];

  if (options.loggedIn) {
    groups.push({
      label: "我的",
      items: [
        { key: "me", href: "/me", label: "概览", icon: "user", exact: true },
        { key: "me-seeding", href: "/me/seeding", label: "做种", icon: "upload" },
        { key: "me-leeching", href: "/me/leeching", label: "下载", icon: "download" },
        { key: "me-bonus", href: "/me/bonus", label: "魔力值", icon: "sparkles" },
        { key: "upload", href: "/upload", label: "发布", icon: "upload" },
        { key: "rss", href: "/me/rss", label: "RSS", icon: "scroll-text" },
      ],
    });
  }

  const staff: NavGroup[] = [];
  if (options.canReview) {
    staff.push({
      items: [
        { key: "staff-review", href: "/staff/review", label: "审核台", icon: "clipboard-check" },
      ],
    });
  }

  return { site: groups, staff };
}

function parseCharter(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function loadSections(db: Db): Promise<Section[]> {
  const sectionRows = await db
    .selectFrom("sections")
    .selectAll()
    .orderBy("display_order", "asc")
    .execute();
  const categoryRows = await db
    .selectFrom("categories")
    .selectAll()
    .orderBy("display_order", "asc")
    .execute();

  return sectionRows.map((section) => {
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(section.config_json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // 损坏的 config 视为空配置，不阻塞 bootstrap。
    }

    const fieldsResult = sectionFieldSchema.array().safeParse(config.fields ?? []);

    return {
      slug: section.slug,
      name: section.name,
      display_order: Number(section.display_order),
      review_mode: section.review_mode,
      charter: parseCharter(config.charter),
      fields: fieldsResult.success ? fieldsResult.data : [],
      categories: categoryRows
        .filter((category) => Number(category.section_id) === Number(section.id))
        .map((category) => ({
          id: Number(category.id),
          slug: category.slug,
          name: category.name,
        })),
    };
  });
}

async function loadCounts(db: Db, userId: number | null): Promise<BootstrapCounts> {
  const pending = await db
    .selectFrom("torrents")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("status", "=", "pending")
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  return {
    pending_review: numberCount(pending),
    // reports / anomalies 表在后续纵切创建
    open_reports: 0,
    anomalies: 0,
    unread: userId === null ? 0 : await unreadNotificationCount(db, userId),
  };
}

async function loadHomeStats(db: Db): Promise<HomeStats> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [users, torrents, sums, newToday] = await Promise.all([
    db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "active")
      .executeTakeFirst(),
    db
      .selectFrom("torrents")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "approved")
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("torrents")
      .select([
        (eb) => eb.fn.sum<number>("seeders").as("seeders"),
        (eb) => eb.fn.sum<number>("leechers").as("leechers"),
      ])
      .where("status", "=", "approved")
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("torrents")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "approved")
      .where("created_at", ">=", startOfToday.getTime())
      .executeTakeFirst(),
  ]);

  const seeders = Number(sums?.seeders ?? 0);
  const leechers = Number(sums?.leechers ?? 0);

  return {
    users: numberCount(users),
    torrents: numberCount(torrents),
    seeders,
    leechers,
    peers: seeders + leechers,
    new_today: numberCount(newToday),
  };
}

async function loadLatestTorrents(db: Db, viewerId: number | null): Promise<TorrentSummary[]> {
  const rows = await db
    .selectFrom("torrents as t")
    .innerJoin("sections as s", "s.id", "t.section_id")
    .innerJoin("categories as c", "c.id", "t.category_id")
    .leftJoin("users as u", "u.id", "t.uploader_id")
    .select([
      "t.id as id",
      "t.name as name",
      "t.size as size",
      "t.files_count as files_count",
      "t.promo as promo",
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
    ])
    .where("t.status", "=", "approved")
    .where("t.deleted_at", "is", null)
    .orderBy("t.created_at", "desc")
    .limit(8)
    .execute();

  const ids = rows.map((row) => Number(row.id));
  const tagRows =
    ids.length > 0
      ? await db
          .selectFrom("torrent_tags as tt")
          .innerJoin("tags as tg", "tg.id", "tt.tag_id")
          .select(["tt.torrent_id as torrent_id", "tg.name as name"])
          .where("tt.torrent_id", "in", ids)
          .execute()
      : [];

  const tagsByTorrent = new Map<number, string[]>();
  for (const tag of tagRows) {
    const key = Number(tag.torrent_id);
    const list = tagsByTorrent.get(key) ?? [];
    list.push(tag.name);
    tagsByTorrent.set(key, list);
  }

  return rows.map((row) => {
    const id = Number(row.id);
    return toTorrentSummary(
      {
        id,
        name: row.name,
        size: Number(row.size),
        files_count: Number(row.files_count),
        promo: row.promo,
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
      } satisfies TorrentJoinRow,
      tagsByTorrent.get(id) ?? [],
      viewerId !== null && Number(row.uploader_id) === viewerId,
    );
  });
}

async function loadAnnouncements(db: Db): Promise<Announcement[]> {
  const rows = await db
    .selectFrom("announcements as a")
    .leftJoin("users as u", "u.id", "a.author_id")
    .select([
      "a.id as id",
      "a.title as title",
      "a.body as body",
      "a.pinned as pinned",
      "a.tone as tone",
      "a.created_at as created_at",
      "u.username as author",
    ])
    .orderBy("a.pinned", "desc")
    .orderBy("a.created_at", "desc")
    .limit(5)
    .execute();

  const output: Announcement[] = [];
  for (const row of rows) {
    const parsed = announcementSchema.safeParse({
      id: Number(row.id),
      title: row.title,
      body: row.body,
      author: row.author,
      pinned: Number(row.pinned) === 1,
      tone: row.tone,
      created_at: Number(row.created_at),
    });
    if (parsed.success) output.push(parsed.data);
  }
  return output;
}

async function loadPromos(db: Db): Promise<PromoEvent[]> {
  const rows = await db
    .selectFrom("promo_events")
    .selectAll()
    .orderBy("id", "desc")
    .limit(5)
    .execute();

  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    scope: row.scope,
    promo: row.promo,
    starts_at: row.starts_at === null ? null : Number(row.starts_at),
    ends_at: row.ends_at === null ? null : Number(row.ends_at),
  }));
}

export function siteRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/site`, async () => {
      const settings = await loadSettings(db);
      return toSiteIdentity(settings, APP_VERSION);
    });

    app.get(`${API_PREFIX}/bootstrap`, async (request) => {
      const auth = request.auth;
      const permissions = auth ? permissionsFor(auth.user.role) : [];
      const [settings, sections, counts] = await Promise.all([
        loadSettings(db),
        loadSections(db),
        loadCounts(db, auth ? Number(auth.user.id) : null),
      ]);

      return bootstrap.parse({
        site: toSiteIdentity(settings, APP_VERSION),
        nav: buildNav({
          loggedIn: Boolean(auth),
          canReview: permissions.includes(PERMISSIONS.staffReview),
        }),
        sections,
        permissions,
        counts,
        me: auth ? toUserSummary(auth.user) : null,
        config_version: "1",
      });
    });

    app.get(`${API_PREFIX}/home`, async (request) => {
      const [stats, latest, announcements, promos] = await Promise.all([
        loadHomeStats(db),
        loadLatestTorrents(db, request.auth ? Number(request.auth.user.id) : null),
        loadAnnouncements(db),
        loadPromos(db),
      ]);

      return homeResponse.parse({
        stats,
        latest,
        announcements,
        promos,
        my: request.auth
          ? {
              unread: await unreadNotificationCount(db, Number(request.auth.user.id)),
              hnr_due: 0,
            }
          : null,
      });
    });

    app.get(`${API_PREFIX}/rules`, async () => {
      const [settings, sections] = await Promise.all([loadSettings(db), loadSections(db)]);

      return rulesResponse.parse({
        registration: settings.registration,
        review: settings.review,
        tracker: {
          announce_interval: settings.tracker.announce_interval,
          min_interval: settings.tracker.min_interval,
        },
        hnr: DEFAULT_HNR_POLICY,
        sections: sections.map((section) => ({
          slug: section.slug,
          name: section.name,
          review_mode: section.review_mode,
          charter: section.charter,
          fields: section.fields,
        })),
      });
    });
  };
}
