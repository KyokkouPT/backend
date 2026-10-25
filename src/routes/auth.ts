import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import {
  API_PREFIX,
  authMeResponse,
  csrfResponse,
  loginRequest,
  loginResponse,
  signupRequest,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { assertCsrf } from "../auth/csrf.js";
import { hashPassword, runDummyKdf, verifyPassword } from "../auth/password.js";
import { permissionsFor } from "../auth/permissions.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieOptions,
  createSession,
  deleteSession,
  newToken,
  sha256,
} from "../auth/session.js";
import { HttpProblem, badRequest, conflict } from "../lib/problem.js";
import { verifyTotp } from "../lib/totp.js";
import { createNotification, unreadNotificationCount } from "../lib/notifications.js";
import { loadSettings } from "../lib/settings.js";
import { numberCount, toUserSummary } from "../lib/serialize.js";
import { parseOrThrow } from "../lib/validate.js";

export function authRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;
    const cookieBase = cookieOptions(config.nodeEnv, SESSION_TTL_MS / 1000);

    /**
     * 发放/轮换 CSRF token。
     * 已登录时必须同步 session.csrf_hash，否则登录后的写请求会全部 403。
     */
    app.get(`${API_PREFIX}/auth/csrf`, async (request, reply) => {
      const csrfToken = newToken();

      if (request.auth) {
        await db
          .updateTable("sessions")
          .set({ csrf_hash: sha256(csrfToken) })
          .where("id", "=", request.auth.session.id)
          .execute();
      }

      reply.setCookie(CSRF_COOKIE, csrfToken, { ...cookieBase, httpOnly: false });
      return csrfResponse.parse({ csrf_token: csrfToken });
    });

    app.post(
      `${API_PREFIX}/auth/login`,
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const body = parseOrThrow(loginRequest, request.body);
        // 登录前没有 session，只做 header == cookie 的 double-submit 校验。
        assertCsrf(request, null);

        const identifier = body.username.trim();
        const user = await db
          .selectFrom("users")
          .selectAll()
          .where((eb) =>
            eb.or([eb("username", "=", identifier), eb("email", "=", identifier.toLowerCase())]),
          )
          .executeTakeFirst();

        // 用户不存在也跑一次等价 KDF，避免用响应时间枚举账号。
        const valid = user
          ? await verifyPassword(user.password_hash, body.password)
          : (await runDummyKdf(body.password), false);

        if (!user || !valid || user.status !== "active") {
          throw new HttpProblem(401, "invalid_credentials", "用户名或密码不正确");
        }

        // 已启用 2FA：必须提供 TOTP 或一次性恢复码。
        if (Number(user.twofa_enabled ?? 0) === 1) {
          const totp = body.totp_code?.replace(/\s+/g, "") ?? "";
          const recovery = body.recovery_code?.trim().toUpperCase() ?? "";
          let verified = false;

          if (totp.length > 0 && user.twofa_secret && verifyTotp(user.twofa_secret, totp)) {
            verified = true;
          } else if (recovery.length > 0) {
            const row = await db
              .selectFrom("twofa_recovery_codes")
              .select("id")
              .where("user_id", "=", user.id)
              .where("code_hash", "=", sha256(recovery))
              .where("used_at", "is", null)
              .executeTakeFirst();
            if (row) {
              await db
                .updateTable("twofa_recovery_codes")
                .set({ used_at: Date.now() })
                .where("id", "=", row.id)
                .execute();
              verified = true;
            }
          }

          if (!verified) throw new HttpProblem(401, "twofa_required", "需要两步验证码");
        }

        const session = await createSession(db, Number(user.id), {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });

        await db
          .updateTable("users")
          .set({ last_seen_at: Date.now() })
          .where("id", "=", user.id)
          .execute();

        reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase, httpOnly: true });
        reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...cookieBase, httpOnly: false });

        return loginResponse.parse({
          user: toUserSummary(user),
          csrf_token: session.csrfToken,
        });
      },
    );

    app.post(
      `${API_PREFIX}/auth/signup`,
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const body = parseOrThrow(signupRequest, request.body);
        assertCsrf(request, null);

        const settings = await loadSettings(db);
        if (!settings.registration.open && !settings.registration.invite_registration_enabled) {
          throw new HttpProblem(403, "registration_closed", "站点当前关闭注册");
        }

        const inviteCode = body.invite_code?.trim().toUpperCase() ?? "";
        if (!settings.registration.open && inviteCode.length === 0) {
          throw badRequest("invite_required", "当前需要邀请码才能注册");
        }

        let inviterId: number | null = null;
        if (inviteCode.length > 0) {
          const invite = await db
            .selectFrom("invites")
            .selectAll()
            .where("code", "=", inviteCode)
            .executeTakeFirst();
          if (!invite || invite.status !== "unused" || Number(invite.expires_at) <= Date.now()) {
            throw badRequest("invalid_invite", "邀请码不存在、已被使用或已过期");
          }
          inviterId = Number(invite.inviter_id);
        }

        const username = body.username.trim();
        const email = body.email.trim().toLowerCase();
        const existing = await db
          .selectFrom("users")
          .select("id")
          .where((eb) => eb.or([eb("username", "=", username), eb("email", "=", email)]))
          .executeTakeFirst();
        if (existing) throw conflict("account_exists", "用户名或邮箱已被使用");

        const now = Date.now();
        const passwordHash = await hashPassword(body.password);
        const passkey = randomBytes(16).toString("hex");

        await db.transaction().execute(async (trx) => {
          if (inviteCode.length > 0) {
            const consumed = await trx
              .updateTable("invites")
              .set({ status: "used", used_at: now })
              .where("code", "=", inviteCode)
              .where("status", "=", "unused")
              .execute();
            if (Number(consumed[0]?.numUpdatedRows ?? 0) === 0) {
              throw badRequest("invalid_invite", "邀请码已被使用");
            }
          }

          await trx
            .insertInto("users")
            .values({
              username,
              email,
              password_hash: passwordHash,
              passkey,
              role: "user",
              class_key: "user",
              status: "active",
              uploaded: 0,
              downloaded: 0,
              bonus: 0,
              seedtime: 0,
              invited_by: inviterId,
              created_at: now,
              last_seen_at: now,
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

          if (inviteCode.length > 0) {
            await trx
              .updateTable("invites")
              .set({ invited_user_id: Number(created.id) })
              .where("code", "=", inviteCode)
              .execute();
          }
        });

        const user = await db
          .selectFrom("users")
          .selectAll()
          .where("username", "=", username)
          .executeTakeFirstOrThrow();

        if (inviterId !== null) {
          try {
            await createNotification(db, {
              userId: inviterId,
              kind: "invite",
              title: "邀请码已被使用",
              body: `${username} 已通过你的邀请码注册。`,
              linkUrl: "/me/invite",
            });
          } catch {
            // 通知失败不阻塞注册
          }
        }

        const session = await createSession(db, Number(user.id), {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });

        reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase, httpOnly: true });
        reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...cookieBase, httpOnly: false });

        return reply.status(201).send(
          loginResponse.parse({
            user: toUserSummary(user),
            csrf_token: session.csrfToken,
          }),
        );
      },
    );

    app.post(`${API_PREFIX}/auth/logout`, async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new HttpProblem(401, "auth_required", "需要登录");
      assertCsrf(request, auth.session);

      await deleteSession(db, auth.session.id);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });

      return { ok: true };
    });

    app.get(`${API_PREFIX}/auth/me`, async (request) => {
      const auth = request.auth;
      if (!auth) throw new HttpProblem(401, "auth_required", "需要登录");

      const pending = await db
        .selectFrom("torrents")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("status", "=", "pending")
        .where("deleted_at", "is", null)
        .executeTakeFirst();

      return authMeResponse.parse({
        user: toUserSummary(auth.user),
        permissions: permissionsFor(auth.user.role),
        unread_count: await unreadNotificationCount(db, Number(auth.user.id)),
        todo: { pending_review: numberCount(pending) },
      });
    });
  };
}
