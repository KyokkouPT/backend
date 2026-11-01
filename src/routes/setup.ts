import type { FastifyPluginAsync } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, settingsSchema } from "@kyokkou/config";
import {
  API_PREFIX,
  setupRequest,
  setupResponse,
  setupStatus,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { LATEST_SCHEMA_VERSION } from "../db/migrations/index.js";
import { SECTIONS } from "../db/seed.js";
import { assertCsrf } from "../auth/csrf.js";
import { hashPassword } from "../auth/password.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieOptions,
  createSession,
} from "../auth/session.js";
import { HttpProblem, conflict } from "../lib/problem.js";
import { loadClassBySlug } from "../lib/classes.js";
import { toUserSummary } from "../lib/serialize.js";
import { parseOrThrow } from "../lib/validate.js";

/**
 * 首次安装向导：数据库为空（users 为 0）时允许通过 GUI 创建站点与管理员，
 * 不依赖 .env 里的 ADMIN_*；安装完成后该接口一律返回 409。
 */
export function setupRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;
    const cookieBase = cookieOptions(config.cookieSecure, SESSION_TTL_MS / 1000);

    app.get(`${API_PREFIX}/setup/status`, async () => {
      const row = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirst();
      const count = Number(row?.count ?? 0);

      return setupStatus.parse({
        requires_setup: count === 0,
        user_count: count,
        schema_version: LATEST_SCHEMA_VERSION,
      });
    });

    app.post(
      `${API_PREFIX}/setup`,
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (request, reply) => {
        assertCsrf(request, null);

        // 已安装时直接 409，不泄露表单校验差异。
        const existing = await db
          .selectFrom("users")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .executeTakeFirst();
        if (Number(existing?.count ?? 0) > 0) {
          throw new HttpProblem(409, "already_installed", "站点已完成安装");
        }

        const body = parseOrThrow(setupRequest, request.body ?? {});

        const username = body.admin_username.trim();
        const email = body.admin_email.trim().toLowerCase();
        const now = Date.now();
        const passwordHash = await hashPassword(body.admin_password);
        const passkey = randomBytes(16).toString("hex");
        const ownerClass = await loadClassBySlug(db, "owner");

        const settings = settingsSchema.parse({
          ...DEFAULT_SETTINGS,
          site: {
            ...DEFAULT_SETTINGS.site,
            name: body.site_name.trim(),
            tagline: body.site_tagline?.trim() ?? DEFAULT_SETTINGS.site.tagline,
            locale: body.locale,
          },
          registration: {
            ...DEFAULT_SETTINGS.registration,
            open: body.registration_open,
          },
        });

        let userId = 0;
        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto("users")
            .values({
              username,
              email,
              password_hash: passwordHash,
              passkey,
              role: "admin",
              class_key: ownerClass?.slug ?? "owner",
              class_id: ownerClass ? Number(ownerClass.id) : null,
              warnings: 0,
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
          userId = Number(created.id);

          await trx
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

          await trx
            .insertInto("site_settings")
            .values({
              key: "site",
              value_json: JSON.stringify(settings.site),
              updated_at: now,
            })
            .execute();
          await trx
            .insertInto("site_settings")
            .values({
              key: "registration",
              value_json: JSON.stringify(settings.registration),
              updated_at: now,
            })
            .execute();

          await trx
            .insertInto("instance_meta")
            .values({
              instance_id: randomUUID(),
              schema_version: LATEST_SCHEMA_VERSION,
              install_state: "ready",
              installed_at: now,
            })
            .execute();

          await trx
            .insertInto("audit_logs")
            .values({
              actor_id: userId,
              action: "instance.install",
              target_type: "instance",
              target_id: "setup",
              detail_json: JSON.stringify({ base_sections: body.base_sections }),
              ip: request.ip,
              created_at: now,
            })
            .execute();

          if (body.base_sections) {
            for (const [index, section] of SECTIONS.entries()) {
              await trx
                .insertInto("sections")
                .values({
                  slug: section.slug,
                  name: section.name,
                  display_order: index,
                  review_mode: section.reviewMode,
                  config_json: JSON.stringify({
                    fields: section.fields,
                    charter: section.charter,
                  }),
                })
                .execute();

              const createdSection = await trx
                .selectFrom("sections")
                .select("id")
                .where("slug", "=", section.slug)
                .executeTakeFirstOrThrow();

              for (const [catIndex, category] of section.categories.entries()) {
                await trx
                  .insertInto("categories")
                  .values({
                    section_id: Number(createdSection.id),
                    slug: category.slug,
                    name: category.name,
                    display_order: catIndex,
                  })
                  .execute();
              }
            }
          }
        });

        const user = await db
          .selectFrom("users")
          .selectAll()
          .where("id", "=", userId)
          .executeTakeFirstOrThrow();
        const session = await createSession(db, userId, {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });

        reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase, httpOnly: true });
        reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...cookieBase, httpOnly: false });

        return reply.status(201).send(
          setupResponse.parse({
            ok: true,
            user: toUserSummary(user, ownerClass),
            csrf_token: session.csrfToken,
          }),
        );
      },
    );
  };
}
