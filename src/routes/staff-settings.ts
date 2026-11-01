import type { FastifyPluginAsync } from "fastify";
import { SETTING_KEYS, settingsSchema } from "@kyokkou/config";
import {
  API_PREFIX,
  PERMISSIONS,
  createCategoryBody,
  createSectionBody,
  staffActionResponse,
  staffSectionsResponse,
  staffSettingsResponse,
  updateCategoryBody,
  updateSectionBody,
  updateStaffSettingsBody,
  type StaffSectionItem,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { permissionsFor } from "../auth/permissions.js";
import { HttpProblem, conflict, notFound } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { parseOrThrow } from "../lib/validate.js";

function requireSettings(request: Parameters<typeof requireAuth>[0]) {
  const auth = requireAuth(request);
  if (!permissionsFor(auth.user.role).includes(PERMISSIONS.staffSettings)) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

async function saveSetting(db: Db, key: string, value: unknown): Promise<void> {
  const now = Date.now();
  const updated = await db
    .updateTable("site_settings")
    .set({ value_json: JSON.stringify(value), updated_at: now })
    .where("key", "=", key)
    .execute();
  if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
    await db
      .insertInto("site_settings")
      .values({ key, value_json: JSON.stringify(value), updated_at: now })
      .execute();
  }
}

function parseCharter(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as { charter?: unknown };
    return typeof parsed.charter === "string" ? parsed.charter : "";
  } catch {
    return "";
  }
}

export function staffSettingsRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/staff/settings`, async (request) => {
      requireSettings(request);
      return staffSettingsResponse.parse({ settings: await loadSettings(db) });
    });

    app.put(`${API_PREFIX}/staff/settings`, async (request) => {
      const auth = requireSettings(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(updateStaffSettingsBody, request.body ?? {});
      const current = await loadSettings(db);

      const merged = {
        site: { ...current.site, ...(body.site ?? {}) },
        registration: { ...current.registration, ...(body.registration ?? {}) },
        tracker: { ...current.tracker, ...(body.tracker ?? {}) },
        economy: { ...current.economy, ...(body.economy ?? {}) },
        review: { ...current.review, ...(body.review ?? {}) },
      };
      const validated = settingsSchema.parse(merged);

      for (const key of SETTING_KEYS) {
        if (body[key] !== undefined) await saveSetting(db, key, validated[key]);
      }

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "settings.update",
          target_type: "settings",
          target_id: "site_settings",
          detail_json: JSON.stringify({ keys: Object.keys(body) }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();

      return staffSettingsResponse.parse({ settings: validated });
    });

    app.get(`${API_PREFIX}/staff/sections`, async (request) => {
      requireSettings(request);
      const sections = await db
        .selectFrom("sections")
        .selectAll()
        .orderBy("display_order", "asc")
        .execute();
      const categories = await db
        .selectFrom("categories")
        .selectAll()
        .orderBy("display_order", "asc")
        .execute();

      const items: StaffSectionItem[] = sections.map((section) => ({
        id: Number(section.id),
        slug: section.slug,
        name: section.name,
        display_order: Number(section.display_order),
        review_mode: section.review_mode,
        charter: parseCharter(section.config_json),
        categories: categories
          .filter((category) => Number(category.section_id) === Number(section.id))
          .map((category) => ({
            id: Number(category.id),
            slug: category.slug,
            name: category.name,
            display_order: Number(category.display_order),
          })),
      }));

      return staffSectionsResponse.parse({ items });
    });

    app.post(`${API_PREFIX}/staff/sections`, async (request, reply) => {
      const auth = requireSettings(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(createSectionBody, request.body ?? {});

      const existing = await db
        .selectFrom("sections")
        .select("id")
        .where("slug", "=", body.slug)
        .executeTakeFirst();
      if (existing) throw conflict("section_exists", "分区标识已存在");

      await db
        .insertInto("sections")
        .values({
          slug: body.slug,
          name: body.name.trim(),
          display_order: body.display_order ?? 0,
          review_mode: body.review_mode,
          config_json: JSON.stringify({ fields: [], charter: body.charter?.trim() ?? "" }),
        })
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "section.create",
          target_type: "section",
          target_id: body.slug,
          detail_json: null,
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();

      return reply.status(201).send(
        staffActionResponse.parse({
          ok: true,
          status: "created",
          message: `已创建分区「${body.name.trim()}」`,
        }),
      );
    });

    app.post(`${API_PREFIX}/staff/categories`, async (request, reply) => {
      const auth = requireSettings(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(createCategoryBody, request.body ?? {});

      const section = await db
        .selectFrom("sections")
        .select("id")
        .where("slug", "=", body.section_slug)
        .executeTakeFirst();
      if (!section) throw notFound("section_not_found", "分区不存在");

      const existing = await db
        .selectFrom("categories")
        .select("id")
        .where("section_id", "=", Number(section.id))
        .where("slug", "=", body.slug)
        .executeTakeFirst();
      if (existing) throw conflict("category_exists", "该分区下分类已存在");

      await db
        .insertInto("categories")
        .values({
          section_id: Number(section.id),
          slug: body.slug,
          name: body.name.trim(),
          display_order: body.display_order ?? 0,
        })
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "category.create",
          target_type: "category",
          target_id: `${body.section_slug}/${body.slug}`,
          detail_json: null,
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();

      return reply.status(201).send(
        staffActionResponse.parse({
          ok: true,
          status: "created",
          message: `已创建分类「${body.name.trim()}」`,
        }),
      );
    });

    app.put(`${API_PREFIX}/staff/sections/:slug`, async (request) => {
      const auth = requireSettings(request);
      assertCsrf(request, auth.session);
      const slug = (request.params as { slug: string }).slug;
      const body = parseOrThrow(updateSectionBody, request.body ?? {});

      const section = await db
        .selectFrom("sections")
        .selectAll()
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (!section) throw notFound("section_not_found", "分区不存在");

      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.display_order !== undefined) patch.display_order = body.display_order;
      if (body.review_mode !== undefined) patch.review_mode = body.review_mode;
      if (body.charter !== undefined) {
        let config: Record<string, unknown> = {};
        try {
          config = JSON.parse(section.config_json) as Record<string, unknown>;
        } catch {
          config = {};
        }
        config.charter = body.charter;
        patch.config_json = JSON.stringify(config);
      }

      if (Object.keys(patch).length > 0) {
        await db.updateTable("sections").set(patch).where("id", "=", section.id).execute();
      }

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "section.update",
          target_type: "section",
          target_id: slug,
          detail_json: JSON.stringify({ fields: Object.keys(patch) }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();

      return { ok: true };
    });

    app.put(`${API_PREFIX}/staff/categories/:slug`, async (request) => {
      const auth = requireSettings(request);
      assertCsrf(request, auth.session);
      const slug = (request.params as { slug: string }).slug;
      const body = parseOrThrow(updateCategoryBody, request.body ?? {});

      const category = await db
        .selectFrom("categories")
        .selectAll()
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (!category) throw notFound("category_not_found", "分类不存在");

      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.display_order !== undefined) patch.display_order = body.display_order;
      if (Object.keys(patch).length > 0) {
        await db.updateTable("categories").set(patch).where("id", "=", category.id).execute();
      }

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: "category.update",
          target_type: "category",
          target_id: slug,
          detail_json: JSON.stringify({ fields: Object.keys(patch) }),
          ip: request.ip,
          created_at: Date.now(),
        })
        .execute();

      return { ok: true };
    });
  };
}
