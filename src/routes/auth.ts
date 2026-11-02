import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { sql, type SqlBool } from "kysely";
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
import { loadClassById, loadClassBySlug } from "../lib/classes.js";
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
import { normalizeUsername, validateUsername } from "../lib/username.js";
import { createCaptcha, verifyCaptcha } from "../lib/captcha.js";

const CAPTCHA_COOKIE = "kp_captcha";

function usernameOrThrow(raw: string, allowAdmin = false): string {
  const checked = validateUsername(raw, { allowAdmin });
  if (!checked.ok) throw badRequest(checked.code, checked.message);
  return checked.username;
}

export function authRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db, config } = deps;
    const cookieBase = cookieOptions(config.cookieSecure, SESSION_TTL_MS / 1000);

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

    app.get(`${API_PREFIX}/auth/captcha`, async (_request, reply) => {
      const challenge = createCaptcha(config.sessionSecret);
      reply.setCookie(CAPTCHA_COOKIE, challenge.token, {
        ...cookieBase,
        httpOnly: true,
        maxAge: 300,
      });
      reply.header("cache-control", "no-store");
      reply.type("image/svg+xml; charset=utf-8");
      return reply.send(challenge.svg);
    });

    app.post(
      `${API_PREFIX}/auth/login`,
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (request, reply) => {
        // 登录前没有 session，只做 header == cookie 的 double-submit 校验。
        assertCsrf(request, null);
        const body = parseOrThrow(loginRequest, request.body);

        const captchaToken = request.cookies?.[CAPTCHA_COOKIE];
        if (!verifyCaptcha(config.sessionSecret, captchaToken, body.captcha_code)) {
          reply.clearCookie(CAPTCHA_COOKIE, { path: "/" });
          throw new HttpProblem(400, "captcha_invalid", "图形验证码错误或已过期");
        }
        reply.clearCookie(CAPTCHA_COOKIE, { path: "/" });

        const identifier = body.username.trim();
        const identifierLower = identifier.toLowerCase();
        const user = await db
          .selectFrom("users")
          .selectAll()
          .where((eb) =>
            eb.or([eb("username", "=", identifierLower), eb("email", "=", identifierLower)]),
          )
          .executeTakeFirst();

        // 用户不存在也跑一次等价 KDF，避免用响应时间枚举账号。
        const valid = user
          ? await verifyPassword(user.password_hash, body.password)
          : (await runDummyKdf(body.password), false);

        if (!user || !valid) {
          throw new HttpProblem(401, "invalid_credentials", "用户名或密码不正确");
        }
        if (user.status === "banned") {
          throw new HttpProblem(403, "account_banned", "账号已被封禁，请通过申诉入口提交申诉");
        }
        if (user.status !== "active" && user.status !== "suspended") {
          throw new HttpProblem(403, "account_unavailable", "账号当前不可登录");
        }

        // 已启用 2FA：必须提供 TOTP。
        if (Number(user.twofa_enabled ?? 0) === 1) {
          const totp = body.totp_code?.replace(/\s+/g, "") ?? "";
          const verified =
            totp.length > 0 && Boolean(user.twofa_secret) && verifyTotp(user.twofa_secret ?? "", totp);
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

        const classRow =
          user.class_id === null
            ? await loadClassBySlug(db, "user")
            : await loadClassById(db, Number(user.class_id));

        return loginResponse.parse({
          user: toUserSummary(user, classRow),
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
        if (body.password !== body.password_confirm) {
          throw badRequest("password_mismatch", "两次输入的密码不一致");
        }

        const settings = await loadSettings(db);
        if (!settings.registration.open && !settings.registration.invite_registration_enabled) {
          throw new HttpProblem(403, "registration_closed", "站点当前关闭注册");
        }

        const inviteCode = body.invite_code?.trim().toUpperCase() ?? "";
        if (!settings.registration.open && inviteCode.length === 0) {
          throw badRequest("invite_required", "当前需要邀请码才能注册");
        }

        let inviterId: number | null = null;
        let inviteEmail: string | null = null;
        let inviteUsername: string | null = null;
        if (inviteCode.length > 0) {
          const invite = await db
            .selectFrom("invites")
            .selectAll()
            .where(sql<SqlBool>`upper(${sql.ref("code")}) = ${inviteCode}`)
            .executeTakeFirst();
          if (!invite || invite.status !== "unused" || Number(invite.expires_at) <= Date.now()) {
            throw badRequest("invalid_invite", "邀请码不存在、已被使用或已过期");
          }
          inviterId = Number(invite.inviter_id);
          inviteEmail = invite.email === null ? null : invite.email.toLowerCase();
          inviteUsername = invite.username === null ? null : invite.username.toLowerCase();
        }

        const username = usernameOrThrow(body.username);
        const email = body.email.trim().toLowerCase();
        if (inviteUsername !== null && username !== inviteUsername) {
          throw badRequest("invite_username_mismatch", "用户名与邀请码预注册用户名不一致");
        }
        if (inviteEmail !== null && email !== inviteEmail) {
          throw badRequest("invite_email_mismatch", "注册邮箱与邀请码预注册邮箱不一致");
        }
        const existing = await db
          .selectFrom("users")
          .select("id")
          .where((eb) => eb.or([eb("username", "=", username), eb("email", "=", email)]))
          .executeTakeFirst();
        if (existing) throw conflict("account_exists", "用户名或邮箱已被使用");

        const now = Date.now();
        const passwordHash = await hashPassword(body.password);
        const passkey = randomBytes(16).toString("hex");
        const defaultClass = await loadClassBySlug(db, "user");

        await db.transaction().execute(async (trx) => {
          if (inviteCode.length > 0) {
            const consumed = await trx
              .updateTable("invites")
              .set({ status: "used", used_at: now })
              .where(sql<SqlBool>`upper(${sql.ref("code")}) = ${inviteCode}`)
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
              class_id: defaultClass ? Number(defaultClass.id) : null,
              warnings: 0,
              raw_uploaded: 0,
              raw_downloaded: 0,
              invite_balance: defaultClass?.invite_quota ?? 0,
              max_class_once: defaultClass ? Number(defaultClass.id) : 1,
              class_locked_until: null,
              demote_due_at: null,
              status: "active",
              uploaded: 0,
              downloaded: 0,
              bonus: 0,
              seed_points: 0,
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
              .where(sql<SqlBool>`upper(${sql.ref("code")}) = ${inviteCode}`)
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
            user: toUserSummary(user, defaultClass),
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
        user: toUserSummary(auth.user, auth.class),
        permissions: auth.permissions,
        unread_count: await unreadNotificationCount(db, Number(auth.user.id)),
        todo: { pending_review: numberCount(pending) },
      });
    });
  };
}
