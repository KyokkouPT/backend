import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS } from "@kyokkou/config";
import type { SectionField } from "@kyokkou/contracts";
import { hashPassword } from "../auth/password.js";
import type { Db } from "./db.js";
import { LATEST_SCHEMA_VERSION } from "./migrations/index.js";

/**
 * 开发/首次初始化 seed。幂等：按唯一键查重，已存在则跳过
 * （settings 例外：按 key 覆盖为默认值），所以可以重复执行。
 * 用户改过的密码不会被 seed 覆盖。
 */

export type SeedSummary = {
  users: number;
  sections: number;
  categories: number;
  torrents: number;
  tags: number;
  settings: number;
  announcements: number;
  promos: number;
};

const HOUR = 60 * 60 * 1000;

type SectionSeed = {
  slug: string;
  name: string;
  reviewMode: string;
  fields: SectionField[];
  charter: Record<string, string>;
  categories: { slug: string; name: string }[];
};

const field = (
  key: string,
  label: string,
  type: SectionField["type"],
  options: string[] | undefined,
  required: boolean,
  filterable: boolean,
  displayOrder: number,
): SectionField => ({
  key,
  label,
  type,
  options,
  required,
  filterable,
  display_order: displayOrder,
});

export const SECTIONS: SectionSeed[] = [
  {
    slug: "movie",
    name: "影视",
    reviewMode: "pre",
    charter: { naming: "标题.年份.分辨率.来源.编码-发布组" },
    fields: [
      field("resolution", "分辨率", "select", ["2160p", "1080p", "720p"], true, true, 0),
      field("source", "来源", "select", ["UHD BluRay", "BluRay", "WEB-DL", "HDTV"], true, true, 1),
      field("codec", "编码", "select", ["x265", "x264", "AV1"], true, true, 2),
    ],
    categories: [
      { slug: "movie-film", name: "电影" },
      { slug: "movie-tv", name: "剧集" },
      { slug: "movie-doc", name: "纪录片" },
      { slug: "movie-anime", name: "动漫" },
      { slug: "movie-show", name: "综艺" },
    ],
  },
  {
    slug: "game",
    name: "游戏",
    reviewMode: "pre",
    charter: { naming: "游戏名.版本.平台-发布组" },
    fields: [
      field("platform", "平台", "select", ["PC", "PS5", "Xbox", "Switch"], true, true, 0),
      field("version", "版本", "text", undefined, false, false, 1),
    ],
    categories: [
      { slug: "game-pc", name: "PC" },
      { slug: "game-console", name: "主机" },
      { slug: "game-handheld", name: "掌机 / 模拟器" },
      { slug: "game-patch", name: "补丁 / MOD" },
    ],
  },
  {
    slug: "music",
    name: "音乐",
    reviewMode: "pre",
    charter: { naming: "艺术家.专辑.年份.格式" },
    fields: [
      field("format", "格式", "select", ["FLAC", "MP3", "AAC"], true, true, 0),
      field("bitrate", "码率", "select", ["无损", "320", "192"], true, true, 1),
    ],
    categories: [
      { slug: "music-lossless", name: "无损" },
      { slug: "music-lossy", name: "有损" },
      { slug: "music-live", name: "现场 / Bootleg" },
      { slug: "music-ost", name: "原声 / OST" },
    ],
  },
  {
    slug: "ebook",
    name: "电子书",
    reviewMode: "pre",
    charter: { naming: "书名.作者.版本.格式" },
    fields: [
      field("format", "格式", "select", ["EPUB", "PDF", "MOBI"], true, true, 0),
      field("language", "语言", "select", ["中文", "英文"], true, true, 1),
    ],
    categories: [
      { slug: "ebook-epub", name: "EPUB / MOBI" },
      { slug: "ebook-pdf", name: "PDF" },
      { slug: "ebook-comic", name: "漫画 / 画集" },
      { slug: "ebook-audio", name: "有声书" },
    ],
  },
  {
    slug: "learn",
    name: "学习",
    reviewMode: "pre",
    charter: { naming: "课程名.机构.年份" },
    fields: [
      field("format", "形态", "select", ["视频", "文档", "题库"], true, true, 0),
      field("topic", "主题", "text", undefined, false, true, 1),
    ],
    categories: [
      { slug: "learn-course", name: "课程 / 教程" },
      { slug: "learn-book", name: "教材 / 论文" },
      { slug: "learn-exam", name: "题库 / 认证" },
    ],
  },
  {
    slug: "software",
    name: "软件",
    reviewMode: "pre",
    charter: { naming: "软件名.版本.平台" },
    fields: [
      field("platform", "平台", "select", ["Windows", "macOS", "Linux"], true, true, 0),
      field("version", "版本", "text", undefined, false, false, 1),
    ],
    categories: [
      { slug: "software-app", name: "应用 / 工具" },
      { slug: "software-os", name: "系统镜像" },
      { slug: "software-other", name: "其他" },
    ],
  },
];

type UserSeed = {
  username: string;
  email: string;
  role: "user" | "moderator" | "admin";
  classKey: string;
  uploaded: number;
  downloaded: number;
  bonus: number;
  seedtime: number;
};

const USERS: UserSeed[] = [
  {
    username: "lightbringer",
    email: "lightbringer@example.com",
    role: "admin",
    classKey: "master",
    uploaded: 2_002_000_000_000,
    downloaded: 1_615_000_000_000,
    bonus: 8214,
    seedtime: 4_622_400,
  },
  {
    username: "root",
    email: "root@example.com",
    role: "admin",
    classKey: "sysop",
    uploaded: 0,
    downloaded: 0,
    bonus: 0,
    seedtime: 0,
  },
  {
    username: "阿雪",
    email: "axue@example.com",
    role: "user",
    classKey: "user",
    uploaded: 48_000_000_000,
    downloaded: 12_000_000_000,
    bonus: 120,
    seedtime: 86_400,
  },
];

type TorrentSeed = {
  infoHash: string;
  name: string;
  section: string;
  category: string;
  uploader: string;
  size: number;
  promo: string;
  seeders: number;
  leechers: number;
  completed: number;
  description: string;
  meta: Record<string, string>;
  fields: Record<string, string>;
  tags: string[];
  hoursAgo: number;
  files: { path: string; size: number }[];
};

const GB = 1024 * 1024 * 1024;

const TORRENTS: TorrentSeed[] = [
  {
    infoHash: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    name: "Dune.Part.Two.2024.2160p.UHD.BluRay.x265-KyokkouRaws",
    section: "movie",
    category: "movie-film",
    uploader: "lightbringer",
    size: Math.round(32.2 * GB),
    promo: "free",
    seeders: 124,
    leechers: 8,
    completed: 892,
    description:
      "4K UHD 原盘重编码，保留 DoVi Profile 8 与 HDR10 双兼容；音轨为英语 Atmos 与国语 DD5.1。",
    meta: { resolution: "2160p", source: "UHD BluRay", codec: "x265" },
    fields: { resolution: "2160p", source: "UHD BluRay", codec: "x265" },
    tags: ["中字", "HDR"],
    hoursAgo: 3,
    files: [{ path: "Dune.Part.Two.2024.2160p.UHD.BluRay.x265-KyokkouRaws.mkv", size: Math.round(32.2 * GB) }],
  },
  {
    infoHash: "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    name: "Oppenheimer.2023.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX",
    section: "movie",
    category: "movie-film",
    uploader: "root",
    size: Math.round(26.6 * GB),
    promo: "2x",
    seeders: 88,
    leechers: 5,
    completed: 640,
    description: "流媒体源杜比视界版本，含简繁中字与英字。",
    meta: { resolution: "2160p", source: "WEB-DL", codec: "x265" },
    fields: { resolution: "2160p", source: "WEB-DL", codec: "x265" },
    tags: ["中字", "杜比视界"],
    hoursAgo: 9,
    files: [{ path: "Oppenheimer.2023.2160p.WEB-DL.H.265-FLUX.mkv", size: Math.round(26.6 * GB) }],
  },
  {
    infoHash: "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
    name: "The.Zone.of.Interest.2023.1080p.BluRay.x264-SPARKS",
    section: "movie",
    category: "movie-film",
    uploader: "阿雪",
    size: Math.round(9.8 * GB),
    promo: "none",
    seeders: 41,
    leechers: 3,
    completed: 210,
    description: "1080p BluRay 重编码，原声德语与英语字幕。",
    meta: { resolution: "1080p", source: "BluRay", codec: "x264" },
    fields: { resolution: "1080p", source: "BluRay", codec: "x264" },
    tags: ["中字"],
    hoursAgo: 27,
    files: [{ path: "The.Zone.of.Interest.2023.1080p.BluRay.x264-SPARKS.mkv", size: Math.round(9.8 * GB) }],
  },
  {
    infoHash: "4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e",
    name: "Perfect.Days.2023.1080p.BluRay.x264.AAC5.1-MOOVEE",
    section: "movie",
    category: "movie-film",
    uploader: "lightbringer",
    size: Math.round(8.1 * GB),
    promo: "none",
    seeders: 22,
    leechers: 1,
    completed: 96,
    description: "维姆·文德斯新作，日语原声 + 简繁中字。",
    meta: { resolution: "1080p", source: "BluRay", codec: "x264" },
    fields: { resolution: "1080p", source: "BluRay", codec: "x264" },
    tags: ["中字"],
    hoursAgo: 50,
    files: [{ path: "Perfect.Days.2023.1080p.BluRay.x264.AAC5.1-MOOVEE.mkv", size: Math.round(8.1 * GB) }],
  },
  {
    infoHash: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
    name: "Elden.Ring.Shadow.of.the.Erdtree.2024.PS5",
    section: "game",
    category: "game-console",
    uploader: "root",
    size: Math.round(68.0 * GB),
    promo: "none",
    seeders: 67,
    leechers: 12,
    completed: 431,
    description: "PS5 数字版 DLC 完整包，含 1.0 首日补丁。",
    meta: { platform: "PS5", version: "1.0" },
    fields: { platform: "PS5", version: "1.0" },
    tags: ["经典"],
    hoursAgo: 5,
    files: [{ path: "Elden.Ring.Shadow.of.the.Erdtree.2024.PS5.pkg", size: Math.round(68.0 * GB) }],
  },
  {
    infoHash: "6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
    name: "Taylor.Swift.The.Tortured.Poets.Department.2024.FLAC",
    section: "music",
    category: "music-lossless",
    uploader: "阿雪",
    size: Math.round(1.4 * GB),
    promo: "2x",
    seeders: 156,
    leechers: 9,
    completed: 1203,
    description: "24bit/96kHz FLAC 无损，含完整封面与 log。",
    meta: { format: "FLAC", bitrate: "无损" },
    fields: { format: "FLAC", bitrate: "无损" },
    tags: ["无损"],
    hoursAgo: 12,
    files: [
      { path: "01 - Fortnight.flac", size: 88_000_000 },
      { path: "02 - The Tortured Poets Department.flac", size: 91_000_000 },
      { path: "cover.jpg", size: 2_400_000 },
    ],
  },
  {
    infoHash: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
    name: "Designing.Data-Intensive.Applications.2nd.Edition.EPUB",
    section: "ebook",
    category: "ebook-epub",
    uploader: "lightbringer",
    size: Math.round(0.025 * GB),
    promo: "none",
    seeders: 19,
    leechers: 0,
    completed: 88,
    description: "《数据密集型应用系统设计》第二版英文原版 EPUB，含目录与图表。",
    meta: { format: "EPUB", language: "英文" },
    fields: { format: "EPUB", language: "英文" },
    tags: ["教程"],
    hoursAgo: 33,
    files: [{ path: "Designing.Data-Intensive.Applications.2nd.Edition.epub", size: Math.round(0.025 * GB) }],
  },
  {
    infoHash: "8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c",
    name: "CS61A.2024.Structure.and.Interpretation.of.Computer.Programs.1080p",
    section: "learn",
    category: "learn-course",
    uploader: "root",
    size: Math.round(12.0 * GB),
    promo: "none",
    seeders: 53,
    leechers: 6,
    completed: 310,
    description: "UC Berkeley CS61A 2024 春季课程录像，含讲义与作业。",
    meta: { format: "视频", topic: "计算机科学" },
    fields: { format: "视频", topic: "计算机科学" },
    tags: ["教程"],
    hoursAgo: 72,
    files: [
      { path: "lecture-01.mp4", size: 4_200_000_000 },
      { path: "lecture-02.mp4", size: 3_900_000_000 },
      { path: "notes.pdf", size: 28_000_000 },
    ],
  },
];

const TAGS: { slug: string; name: string }[] = [
  { slug: "zh-sub", name: "中字" },
  { slug: "hdr", name: "HDR" },
  { slug: "dolby-vision", name: "杜比视界" },
  { slug: "classic", name: "经典" },
  { slug: "lossless", name: "无损" },
  { slug: "tutorial", name: "教程" },
];

const ANNOUNCEMENTS = [
  {
    title: "全站免费活动：本周末所有种子免费",
    body: "活动期间所有种子下载不计下载量，但仍会产生 H&R 保种义务；免费标记以种子列表展示为准。",
    author: "root",
    pinned: 1,
    tone: "info",
    hoursAgo: 48,
  },
  {
    title: "规则变更：H&R 义务期调整为 14 天",
    body: "基于三个月的数据回溯，完成期限从 21 天收紧为 14 天，下月 1 日生效。",
    author: "root",
    pinned: 1,
    tone: "warn",
    hoursAgo: 120,
  },
  {
    title: "新增学习分区：课程与题库支持字段筛选",
    body: "学习分区已支持按形态与主题筛选；发布时请填写对应字段，便于检索。",
    author: "lightbringer",
    pinned: 0,
    tone: "info",
    hoursAgo: 192,
  },
];

async function findId(
  db: Db,
  table: "users" | "sections" | "categories" | "torrents" | "tags",
  column: "username" | "slug" | "info_hash",
  value: string,
  extra: { sectionId?: number } = {},
): Promise<number | null> {
  let query = db.selectFrom(table).select("id").where(`${table}.${column}` as never, "=", value as never);
  if (table === "categories" && extra.sectionId !== undefined) {
    query = query.where("section_id", "=", extra.sectionId);
  }
  const row = await query.executeTakeFirst();
  return row ? Number(row.id) : null;
}

export async function seedDatabase(db: Db, options: { password: string }): Promise<SeedSummary> {
  const now = Date.now();
  const summary: SeedSummary = {
    users: 0,
    sections: 0,
    categories: 0,
    torrents: 0,
    tags: 0,
    settings: 0,
    announcements: 0,
    promos: 0,
  };

  // 分区
  const sectionIds = new Map<string, number>();
  for (const [index, section] of SECTIONS.entries()) {
    const existing = await findId(db, "sections", "slug", section.slug);
    const configJson = JSON.stringify({ fields: section.fields, charter: section.charter });
    if (existing === null) {
      await db
        .insertInto("sections")
        .values({
          slug: section.slug,
          name: section.name,
          display_order: index,
          review_mode: section.reviewMode,
          config_json: configJson,
        })
        .execute();
      summary.sections += 1;
    } else {
      await db
        .updateTable("sections")
        .set({
          name: section.name,
          display_order: index,
          review_mode: section.reviewMode,
          config_json: configJson,
        })
        .where("id", "=", existing)
        .execute();
    }
    const id = await findId(db, "sections", "slug", section.slug);
    if (id === null) throw new Error(`section ${section.slug} missing after upsert`);
    sectionIds.set(section.slug, id);
  }

  // 分类
  const categoryIds = new Map<string, number>();
  for (const section of SECTIONS) {
    const sectionId = sectionIds.get(section.slug);
    if (sectionId === undefined) throw new Error(`section ${section.slug} not seeded`);
    for (const [index, category] of section.categories.entries()) {
      const existing = await findId(db, "categories", "slug", category.slug, { sectionId });
      if (existing === null) {
        await db
          .insertInto("categories")
          .values({
            section_id: sectionId,
            slug: category.slug,
            name: category.name,
            display_order: index,
          })
          .execute();
        summary.categories += 1;
      }
      const id = await findId(db, "categories", "slug", category.slug, { sectionId });
      if (id === null) throw new Error(`category ${category.slug} missing after upsert`);
      categoryIds.set(category.slug, id);
    }
  }

  // 用户
  const userIds = new Map<string, number>();
  for (const user of USERS) {
    const existing = await findId(db, "users", "username", user.username);
    if (existing === null) {
      await db
        .insertInto("users")
        .values({
          username: user.username,
          email: user.email,
          password_hash: await hashPassword(options.password),
          passkey: randomBytes(16).toString("hex"),
          role: user.role,
          class_key: user.classKey,
          status: "active",
          uploaded: user.uploaded,
          downloaded: user.downloaded,
          bonus: user.bonus,
          seedtime: user.seedtime,
          invited_by: null,
          created_at: now - 180 * 24 * HOUR,
          last_seen_at: now,
        })
        .execute();
      summary.users += 1;
    }
    const id = await findId(db, "users", "username", user.username);
    if (id === null) throw new Error(`user ${user.username} missing after upsert`);
    userIds.set(user.username, id);
  }

  // 标签
  const tagIds = new Map<string, number>();
  for (const tag of TAGS) {
    const existing = await findId(db, "tags", "slug", tag.slug);
    if (existing === null) {
      await db.insertInto("tags").values({ slug: tag.slug, name: tag.name }).execute();
      summary.tags += 1;
    }
    const id = await findId(db, "tags", "slug", tag.slug);
    if (id === null) throw new Error(`tag ${tag.slug} missing after upsert`);
    tagIds.set(tag.name, id);
  }

  // 种子
  const torrentIds = new Map<string, number>();
  for (const torrent of TORRENTS) {
    const existing = await findId(db, "torrents", "info_hash", torrent.infoHash);
    let torrentId = existing;
    if (existing === null) {
      const sectionId = sectionIds.get(torrent.section);
      const categoryId = categoryIds.get(torrent.category);
      const uploaderId = userIds.get(torrent.uploader);
      if (sectionId === undefined || categoryId === undefined || uploaderId === undefined) {
        throw new Error(`seed references missing section/category/user for ${torrent.name}`);
      }
      const createdAt = now - torrent.hoursAgo * HOUR;
      await db
        .insertInto("torrents")
        .values({
          info_hash: torrent.infoHash,
          name: torrent.name,
          section_id: sectionId,
          category_id: categoryId,
          uploader_id: uploaderId,
          size: torrent.size,
          files_count: torrent.files.length,
          status: "approved",
          promo: torrent.promo,
          seeders: torrent.seeders,
          leechers: torrent.leechers,
          completed: torrent.completed,
          description: torrent.description,
          meta_json: JSON.stringify(torrent.meta),
          torrent_blob: null,
          created_at: createdAt,
          approved_at: createdAt,
          deleted_at: null,
        })
        .execute();
      torrentId = await findId(db, "torrents", "info_hash", torrent.infoHash);
      if (torrentId === null) throw new Error(`torrent ${torrent.name} missing after insert`);
      summary.torrents += 1;

      await db
        .insertInto("torrent_files")
        .values(torrent.files.map((file) => ({ torrent_id: torrentId as number, path: file.path, size: file.size })))
        .execute();

      const fieldValues = Object.entries(torrent.fields).map(([key, value]) => ({
        torrent_id: torrentId as number,
        field_key: key,
        value_text: value,
      }));
      if (fieldValues.length > 0) {
        await db.insertInto("torrent_field_values").values(fieldValues).execute();
      }

      const tagRows = torrent.tags
        .map((name) => tagIds.get(name))
        .filter((id): id is number => typeof id === "number")
        .map((tagId) => ({ torrent_id: torrentId as number, tag_id: tagId }));
      if (tagRows.length > 0) {
        await db.insertInto("torrent_tags").values(tagRows).execute();
      }
    }
    if (torrentId !== null) torrentIds.set(torrent.infoHash, torrentId);
  }

  // 设置（按 key 覆盖为默认值，保证新库与升级后字段齐全）
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.deleteFrom("site_settings").where("key", "=", key).execute();
    await db
      .insertInto("site_settings")
      .values({ key, value_json: JSON.stringify(value), updated_at: now })
      .execute();
    summary.settings += 1;
  }

  // 公告
  for (const announcement of ANNOUNCEMENTS) {
    const existing = await db
      .selectFrom("announcements")
      .select("id")
      .where("title", "=", announcement.title)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("announcements")
        .values({
          title: announcement.title,
          body: announcement.body,
          author_id: userIds.get(announcement.author) ?? null,
          pinned: announcement.pinned,
          tone: announcement.tone,
          created_at: now - announcement.hoursAgo * HOUR,
        })
        .execute();
      summary.announcements += 1;
    }
  }

  // 促销活动
  const promos = [
    {
      name: "周末全站免费",
      scope: "全站",
      promo: "free",
      starts_at: now - 24 * HOUR,
      ends_at: now + 48 * HOUR,
    },
    { name: "冷门种续命", scope: "做种者 < 3 的种子", promo: "2x", starts_at: null, ends_at: null },
  ];
  for (const promo of promos) {
    const existing = await db
      .selectFrom("promo_events")
      .select("id")
      .where("name", "=", promo.name)
      .executeTakeFirst();
    if (!existing) {
      await db.insertInto("promo_events").values(promo).execute();
      summary.promos += 1;
    }
  }

  // 经济与 H&R 初始数据
  const existingPolicy = await db
    .selectFrom("hnr_policies")
    .select("id")
    .where("section_id", "is", null)
    .executeTakeFirst();
  if (!existingPolicy) {
    await db
      .insertInto("hnr_policies")
      .values({
        section_id: null,
        enabled: 1,
        include_rate: 100,
        min_download: 10 * GB,
        seed_seconds: 72 * 3600,
        deadline_days: 14,
        exempt_json: null,
        created_at: now,
      })
      .execute();
  }

  const exchangeSeeds = [
    {
      key: "upload_10gb",
      name: "10 GB 上传量",
      description: "把 10 GB 上传量加到账号。",
      price: 5000,
      amount: 10 * GB,
      display_order: 0,
    },
    {
      key: "upload_50gb",
      name: "50 GB 上传量",
      description: "把 50 GB 上传量加到账号。",
      price: 20000,
      amount: 50 * GB,
      display_order: 1,
    },
    {
      key: "upload_100gb",
      name: "100 GB 上传量",
      description: "把 100 GB 上传量加到账号。",
      price: 36000,
      amount: 100 * GB,
      display_order: 2,
    },
  ];
  for (const item of exchangeSeeds) {
    const existing = await db
      .selectFrom("exchange_items")
      .select("id")
      .where("key", "=", item.key)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("exchange_items")
        .values({
          key: item.key,
          name: item.name,
          description: item.description,
          price: item.price,
          inventory: null,
          limit_per_user: null,
          enabled: 1,
          payload_json: JSON.stringify({ type: "upload", amount: item.amount }),
          display_order: item.display_order,
        })
        .execute();
    }
  }

  const snatchSeeds = [
    {
      username: "lightbringer",
      infoHash: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      uploaded: Math.round(412.8 * GB),
      downloaded: Math.round(32.2 * GB),
      seedtime: 142 * 3600 + 12 * 60,
      status: "seeding",
    },
    {
      username: "lightbringer",
      infoHash: "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
      uploaded: Math.round(1.4 * GB),
      downloaded: Math.round(12.1 * GB),
      seedtime: 0,
      status: "leeching",
    },
    {
      username: "阿雪",
      infoHash: "6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a",
      uploaded: Math.round(18.2 * GB),
      downloaded: Math.round(1.4 * GB),
      seedtime: 30 * 3600,
      status: "seeding",
    },
  ];
  for (const snatch of snatchSeeds) {
    const userId = userIds.get(snatch.username);
    const torrentId = torrentIds.get(snatch.infoHash);
    if (userId === undefined || torrentId === undefined) continue;

    const existing = await db
      .selectFrom("snatches")
      .select("id")
      .where("user_id", "=", userId)
      .where("torrent_id", "=", torrentId)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("snatches")
        .values({
          user_id: userId,
          torrent_id: torrentId,
          uploaded: snatch.uploaded,
          downloaded: snatch.downloaded,
          seedtime: snatch.seedtime,
          last_announce_at: now - 12 * 60 * 1000,
          status: snatch.status,
          completed_at: snatch.status === "seeding" ? now - 24 * HOUR : null,
        })
        .execute();
    }
  }

  const ledgerCount = await db
    .selectFrom("bonus_ledger")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirst();
  if (Number(ledgerCount?.count ?? 0) === 0) {
    const userId = userIds.get("lightbringer");
    if (userId !== undefined) {
      const user = await db
        .selectFrom("users")
        .select("bonus")
        .where("id", "=", userId)
        .executeTakeFirst();
      await db
        .insertInto("bonus_ledger")
        .values({
          user_id: userId,
          kind: "grant",
          delta: Number(user?.bonus ?? 0),
          balance_after: Number(user?.bonus ?? 0),
          ref_type: "seed",
          ref_id: null,
          note: "初始魔力值",
          created_at: now - 48 * HOUR,
        })
        .execute();
    }
  }

  // 首次访问 /me/bonus 时只推进结算时间，不补发历史产出。
  const lightbringerId = userIds.get("lightbringer");
  if (lightbringerId !== undefined) {
    await db
      .updateTable("users")
      .set({ last_bonus_at: now })
      .where("id", "=", lightbringerId)
      .where("last_bonus_at", "is", null)
      .execute();
  }

  // 社区：通知/隐私偏好、演示邀请码、演示求种
  for (const username of ["lightbringer", "root", "阿雪"]) {
    const userId = userIds.get(username);
    if (userId === undefined) continue;
    const existing = await db
      .selectFrom("user_preferences")
      .select("id")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("user_preferences")
        .values({
          user_id: userId,
          email_review: 1,
          email_hnr: 1,
          email_invite: 1,
          email_social: 0,
          email_weekly: 0,
          public_seeding: 1,
          public_published: 1,
          searchable: 1,
          updated_at: now,
        })
        .execute();
    }
  }

  const demoInviteCode = "KYKDEMO1";
  const existingInvite = await db
    .selectFrom("invites")
    .select("id")
    .where("code", "=", demoInviteCode)
    .executeTakeFirst();
  const inviterId = userIds.get("lightbringer");
  if (!existingInvite && inviterId !== undefined) {
    await db
      .insertInto("invites")
      .values({
        code: demoInviteCode,
        inviter_id: inviterId,
        invited_user_id: null,
        status: "unused",
        note: "seed demo invite",
        expires_at: now + 30 * 24 * HOUR,
        created_at: now,
        used_at: null,
      })
      .execute();
  }

  const requestSeeds = [
    {
      username: "lightbringer",
      title: "求 4K 原盘《沙丘 2》国配版",
      description: "需要国语配音 + 简中字幕。",
      bounty: 500,
    },
    {
      username: "阿雪",
      title: "求 CS61B 2024 春季课程录像",
      description: "含讲义与作业。",
      bounty: 500,
    },
  ];
  for (const seed of requestSeeds) {
    const userId = userIds.get(seed.username);
    if (userId === undefined) continue;

    const existing = await db
      .selectFrom("requests")
      .select("id")
      .where("title", "=", seed.title)
      .executeTakeFirst();
    if (existing) continue;

    await db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom("users")
        .select("bonus")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      const balance = Number(user.bonus);
      if (balance < seed.bounty) return;

      const nextBalance = balance - seed.bounty;
      await trx
        .updateTable("users")
        .set({ bonus: nextBalance })
        .where("id", "=", userId)
        .execute();
      await trx
        .insertInto("bonus_ledger")
        .values({
          user_id: userId,
          kind: "request_escrow",
          delta: -seed.bounty,
          balance_after: nextBalance,
          ref_type: "request",
          ref_id: null,
          note: seed.title,
          created_at: now,
        })
        .execute();
      await trx
        .insertInto("requests")
        .values({
          user_id: userId,
          title: seed.title,
          description: seed.description,
          category_id: null,
          bounty_bonus: seed.bounty,
          status: "open",
          created_at: now,
          resolved_at: null,
          fulfilled_by: null,
        })
        .execute();
    });
  }

  // 审核 / 申诉演示数据
  const axueSeedId = userIds.get("阿雪");
  const lightSeedId = userIds.get("lightbringer");
  const duneSeedId = torrentIds.get("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");

  if (axueSeedId !== undefined && duneSeedId !== undefined) {
    const existing = await db
      .selectFrom("reports")
      .select("id")
      .where("target_type", "=", "torrent")
      .where("target_id", "=", String(duneSeedId))
      .where("reason", "=", "quality")
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("reports")
        .values({
          reporter_id: axueSeedId,
          target_type: "torrent",
          target_id: String(duneSeedId),
          target_label: "Dune.Part.Two.2024.2160p.UHD.BluRay.x265-KyokkouRaws",
          reason: "quality",
          detail: "音轨与页面标注不一致。",
          status: "open",
          resolved_by: null,
          resolved_at: null,
          created_at: now - 6 * HOUR,
        })
        .execute();
    }
  }

  if (lightSeedId !== undefined) {
    const existing = await db
      .selectFrom("anomalies")
      .select("id")
      .where("user_id", "=", lightSeedId)
      .where("kind", "=", "ratio_anomaly")
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("anomalies")
        .values({
          user_id: lightSeedId,
          kind: "ratio_anomaly",
          severity: "medium",
          status: "open",
          detail_json: JSON.stringify({ note: "短时间上传量异常增长" }),
          resolved_by: null,
          resolved_at: null,
          created_at: now - 3 * HOUR,
        })
        .execute();
    }
  }

  if (axueSeedId !== undefined) {
    const existing = await db
      .selectFrom("appeals")
      .select("id")
      .where("user_id", "=", axueSeedId)
      .where("kind", "=", "bonus_freeze")
      .executeTakeFirst();
    if (!existing) {
      await db
        .insertInto("appeals")
        .values({
          user_id: axueSeedId,
          kind: "bonus_freeze",
          target_id: null,
          reason: "冻结期间无法兑换，请复核。",
          status: "open",
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
          created_at: now - 2 * HOUR,
        })
        .execute();
      const appeal = await db
        .selectFrom("appeals")
        .select("id")
        .where("user_id", "=", axueSeedId)
        .where("kind", "=", "bonus_freeze")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("appeal_messages")
        .values({
          appeal_id: Number(appeal.id),
          author_id: axueSeedId,
          body: "补充：冻结前没有任何异常下载。",
          created_at: now - 1 * HOUR,
        })
        .execute();
    }
  }

  // 实例元数据
  const meta = await db.selectFrom("instance_meta").selectAll().executeTakeFirst();
  let instanceId: string;
  if (!meta) {
    instanceId = randomUUID();
    await db
      .insertInto("instance_meta")
      .values({
        instance_id: instanceId,
        schema_version: LATEST_SCHEMA_VERSION,
        install_state: "ready",
        installed_at: now,
      })
      .execute();
  } else {
    instanceId = meta.instance_id;
    await db
      .updateTable("instance_meta")
      .set({ schema_version: LATEST_SCHEMA_VERSION, install_state: "ready" })
      .where("id", "=", meta.id)
      .execute();
  }

  // 审计：只在空表时写入一条安装记录
  const auditCount = await db
    .selectFrom("audit_logs")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirst();
  if (Number(auditCount?.count ?? 0) === 0) {
    await db
      .insertInto("audit_logs")
      .values({
        actor_id: userIds.get("root") ?? null,
        action: "instance.seed",
        target_type: "instance",
        target_id: instanceId,
        detail_json: JSON.stringify({ note: "initial seed", torrents: TORRENTS.length }),
        ip: null,
        created_at: now,
      })
      .execute();
  }

  void torrentIds;
  return summary;
}
