import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import {
  API_PREFIX,
  meSettingsResponse,
  preferencesResponse,
  twofaCodeBody,
  twofaEnableResponse,
  twofaPasswordBody,
  twofaSetupResponse,
  updateMeSettingsBody,
  updatePreferencesBody,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { deleteAllSessionsOfUser, sha256 } from "../auth/session.js";
import { HttpProblem, badRequest, conflict } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from "../lib/totp.js";
import { parseOrThrow } from "../lib/validate.js";

function toPreferences(row: {
  email_review: number;
  email_hnr: number;
  email_invite: number;
  email_social: number;
  email_weekly: number;
  public_seeding: number;
  public_published: number;
  searchable: number;
}) {
  return {
    email_review: Number(row.email_review) === 1,
    email_hnr: Number(row.email_hnr) === 1,
    email_invite: Number(row.email_invite) === 1,
    email_social: Number(row.email_social) === 1,
    email_weekly: Number(row.email_weekly) === 1,
    public_seeding: Number(row.public_seeding) === 1,
    public_published: Number(row.public_published) === 1,
    searchable: Number(row.searchable) === 1,
  };
}

const DEFAULT_PREFERENCES = {
  email_review: 1,
  email_hnr: 1,
  email_invite: 1,
  email_social: 0,
  email_weekly: 0,
  public_seeding: 1,
  public_published: 1,
  searchable: 1,
};

export function settingsRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/me/settings`, async (request) => {
      const auth = requireAuth(request);
      return meSettingsResponse.parse({
        username: auth.user.username,
        email: auth.user.email,
        passkey: auth.user.passkey,
        role: auth.user.role,
        class_key: auth.class?.slug ?? auth.user.class_key,
        class: auth.class
          ? {
              slug: auth.class.slug,
              name: auth.class.name,
              rank: Number(auth.class.rank),
              badge: auth.class.badge,
              color: auth.class.color,
            }
          : {
              slug: auth.user.class_key,
              name: auth.user.class_key,
              rank: 0,
              badge: null,
              color: null,
            },
        twofa_enabled: Number(auth.user.twofa_enabled ?? 0) === 1,
      });
    });

    app.put(`${API_PREFIX}/me/settings`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(updateMeSettingsBody, request.body ?? {});

      if (!body.email && !body.password) throw badRequest("nothing_to_update", "没有需要修改的内容");

      if (body.email) {
        const email = body.email.trim().toLowerCase();
        const existing = await db
          .selectFrom("users")
          .select("id")
          .where("email", "=", email)
          .where("id", "!=", Number(auth.user.id))
          .executeTakeFirst();
        if (existing) throw conflict("email_taken", "邮箱已被使用");
        await db.updateTable("users").set({ email }).where("id", "=", Number(auth.user.id)).execute();
      }

      if (body.password) {
        if (!body.current_password) throw badRequest("current_password_required", "修改密码需要当前密码");
        if (!(await verifyPassword(auth.user.password_hash, body.current_password))) {
          throw new HttpProblem(401, "invalid_credentials", "当前密码不正确");
        }
        await db
          .updateTable("users")
          .set({ password_hash: await hashPassword(body.password) })
          .where("id", "=", Number(auth.user.id))
          .execute();
        // 密码修改后旧 session 全部失效。
        await deleteAllSessionsOfUser(db, Number(auth.user.id));
        return { ok: true, sessions_revoked: true };
      }

      return { ok: true, sessions_revoked: false };
    });

    app.post(`${API_PREFIX}/me/passkey/rotate`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const passkey = randomBytes(16).toString("hex");
      await db
        .updateTable("users")
        .set({ passkey })
        .where("id", "=", Number(auth.user.id))
        .execute();
      return { ok: true, passkey };
    });

    app.get(`${API_PREFIX}/me/preferences`, async (request) => {
      const auth = requireAuth(request);
      let row = await db
        .selectFrom("user_preferences")
        .selectAll()
        .where("user_id", "=", Number(auth.user.id))
        .executeTakeFirst();

      if (!row) {
        await db
          .insertInto("user_preferences")
          .values({ user_id: Number(auth.user.id), ...DEFAULT_PREFERENCES, updated_at: Date.now() })
          .execute();
        row = await db
          .selectFrom("user_preferences")
          .selectAll()
          .where("user_id", "=", Number(auth.user.id))
          .executeTakeFirstOrThrow();
      }

      return preferencesResponse.parse(toPreferences(row));
    });

    app.put(`${API_PREFIX}/me/preferences`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(updatePreferencesBody, request.body ?? {});

      let current = await db
        .selectFrom("user_preferences")
        .selectAll()
        .where("user_id", "=", Number(auth.user.id))
        .executeTakeFirst();

      if (!current) {
        await db
          .insertInto("user_preferences")
          .values({ user_id: Number(auth.user.id), ...DEFAULT_PREFERENCES, updated_at: Date.now() })
          .execute();
        current = await db
          .selectFrom("user_preferences")
          .selectAll()
          .where("user_id", "=", Number(auth.user.id))
          .executeTakeFirstOrThrow();
      }

      const patch: Record<string, number> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "boolean") patch[key] = value ? 1 : 0;
      }

      await db
        .updateTable("user_preferences")
        .set({ ...patch, updated_at: Date.now() })
        .where("user_id", "=", Number(auth.user.id))
        .execute();

      const updated = await db
        .selectFrom("user_preferences")
        .selectAll()
        .where("user_id", "=", Number(auth.user.id))
        .executeTakeFirstOrThrow();

      return preferencesResponse.parse(toPreferences(updated));
    });

    app.post(`${API_PREFIX}/me/2fa/setup`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(twofaPasswordBody, request.body ?? {});
      if (!(await verifyPassword(auth.user.password_hash, body.password))) {
        throw new HttpProblem(401, "invalid_credentials", "密码不正确");
      }

      const site = await loadSettings(db);
      const secret = generateTotpSecret();
      await db
        .updateTable("users")
        .set({ twofa_secret: secret, twofa_enabled: 0 })
        .where("id", "=", Number(auth.user.id))
        .execute();

      return twofaSetupResponse.parse({
        secret,
        otpauth_url: otpauthUrl(secret, auth.user.username, site.site.name),
      });
    });

    app.post(`${API_PREFIX}/me/2fa/enable`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(twofaCodeBody, request.body ?? {});
      if (!auth.user.twofa_secret) throw badRequest("twofa_not_setup", "请先生成 2FA secret");
      if (!verifyTotp(auth.user.twofa_secret, body.code)) {
        throw badRequest("invalid_totp", "动态码不正确");
      }

      const codes = generateRecoveryCodes(8);
      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("users")
          .set({ twofa_enabled: 1 })
          .where("id", "=", Number(auth.user.id))
          .execute();
        await trx.deleteFrom("twofa_recovery_codes").where("user_id", "=", Number(auth.user.id)).execute();
        await trx
          .insertInto("twofa_recovery_codes")
          .values(codes.map((code) => ({ user_id: Number(auth.user.id), code_hash: sha256(code), used_at: null, created_at: now })))
          .execute();
      });

      return twofaEnableResponse.parse({ recovery_codes: codes });
    });

    app.post(`${API_PREFIX}/me/2fa/disable`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(twofaPasswordBody, request.body ?? {});
      if (!(await verifyPassword(auth.user.password_hash, body.password))) {
        throw new HttpProblem(401, "invalid_credentials", "密码不正确");
      }

      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("users")
          .set({ twofa_secret: null, twofa_enabled: 0 })
          .where("id", "=", Number(auth.user.id))
          .execute();
        await trx.deleteFrom("twofa_recovery_codes").where("user_id", "=", Number(auth.user.id)).execute();
      });

      return { ok: true };
    });

    app.post(`${API_PREFIX}/me/2fa/recovery-codes`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(twofaPasswordBody, request.body ?? {});
      if (!(await verifyPassword(auth.user.password_hash, body.password))) {
        throw new HttpProblem(401, "invalid_credentials", "密码不正确");
      }
      if (Number(auth.user.twofa_enabled ?? 0) !== 1) throw badRequest("twofa_disabled", "尚未启用 2FA");

      const codes = generateRecoveryCodes(8);
      const now = Date.now();
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom("twofa_recovery_codes").where("user_id", "=", Number(auth.user.id)).execute();
        await trx
          .insertInto("twofa_recovery_codes")
          .values(codes.map((code) => ({ user_id: Number(auth.user.id), code_hash: sha256(code), used_at: null, created_at: now })))
          .execute();
      });

      return twofaEnableResponse.parse({ recovery_codes: codes });
    });
  };
}
