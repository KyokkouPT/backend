import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../config.js";
import { hashPassword } from "../auth/password.js";
import { createDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { SECTIONS } from "./seed.js";
import { loadClassBySlug } from "../lib/classes.js";

/**
 * 生产初始化：只建管理员（可选导入基础分区模板），不写任何演示数据。
 * 用法：
 *   ADMIN_USERNAME=admin ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... \
 *   BASE_SECTIONS=true pnpm admin:create
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });

  try {
    await runMigrations(db, config.databaseDriver);

    const username = (process.env.ADMIN_USERNAME ?? "admin").trim();
    const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? "";

    if (!email || !password) {
      throw new Error("必须设置 ADMIN_EMAIL 与 ADMIN_PASSWORD");
    }
    if (password.length < 8) {
      throw new Error("ADMIN_PASSWORD 至少 8 位");
    }

    const existing = await db
      .selectFrom("users")
      .select("id")
      .where("username", "=", username)
      .executeTakeFirst();

    if (existing) {
      console.log(`管理员 ${username} 已存在，跳过创建`);
    } else {
      const now = Date.now();
      const passwordHash = await hashPassword(password);
      const ownerClass = await loadClassBySlug(db, "owner");
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("users")
          .values({
            username,
            email,
            password_hash: passwordHash,
            passkey: randomBytes(16).toString("hex"),
            role: "admin",
            class_key: ownerClass?.slug ?? "owner",
            class_id: ownerClass ? Number(ownerClass.id) : null,
            warnings: 0,
            raw_uploaded: 0,
            raw_downloaded: 0,
            invite_balance: 0,
            class_locked_until: null,
            demote_due_at: null,
            status: "active",
            uploaded: 0,
            downloaded: 0,
            bonus: 0,
            seedtime: 0,
            invited_by: null,
            created_at: now,
            last_seen_at: null,
            bonus_frozen_until: null,
            last_bonus_at: now,
          })
          .execute();

        const created = await trx
          .selectFrom("users")
          .select("id")
          .where("username", "=", username)
          .executeTakeFirstOrThrow();

        await trx
          .insertInto("user_preferences")
          .values({
            user_id: Number(created.id),
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

        await trx
          .insertInto("audit_logs")
          .values({
            actor_id: Number(created.id),
            action: "admin.create",
            target_type: "user",
            target_id: String(created.id),
            detail_json: null,
            ip: null,
            created_at: now,
          })
          .execute();
      });

      console.log(`管理员 ${username} 已创建（角色 admin）`);
    }

    if (process.env.BASE_SECTIONS === "true") {
      let inserted = 0;
      for (const [index, section] of SECTIONS.entries()) {
        const exists = await db
          .selectFrom("sections")
          .select("id")
          .where("slug", "=", section.slug)
          .executeTakeFirst();
        if (exists) continue;

        await db
          .insertInto("sections")
          .values({
            slug: section.slug,
            name: section.name,
            display_order: index,
            review_mode: section.reviewMode,
            config_json: JSON.stringify({ fields: section.fields, charter: section.charter }),
          })
          .execute();

        const created = await db
          .selectFrom("sections")
          .select("id")
          .where("slug", "=", section.slug)
          .executeTakeFirstOrThrow();

        for (const [catIndex, category] of section.categories.entries()) {
          await db
            .insertInto("categories")
            .values({
              section_id: Number(created.id),
              slug: category.slug,
              name: category.name,
              display_order: catIndex,
            })
            .execute();
        }
        inserted += 1;
      }
      console.log(`基础分区模板：新增 ${String(inserted)} 个（不含用户/种子/公告/求种等演示数据）`);
    }

    console.log("初始化完成。生产启动：pnpm build && pnpm start");
  } finally {
    await db.destroy();
  }
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isMain) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) console.error(error.message);
    else console.error(error);
    process.exit(1);
  });
}
