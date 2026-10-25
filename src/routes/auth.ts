import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  authMeResponse,
  csrfResponse,
  loginRequest,
  loginResponse,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { assertCsrf } from "../auth/csrf.js";
import { runDummyKdf, verifyPassword } from "../auth/password.js";
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
import { HttpProblem } from "../lib/problem.js";
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
        unread_count: 0,
        todo: { pending_review: numberCount(pending) },
      });
    });
  };
}
