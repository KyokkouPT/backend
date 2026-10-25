import type { FastifyRequest } from "fastify";
import { HttpProblem } from "../lib/problem.js";
import { CSRF_COOKIE, sha256, type SessionRow } from "./session.js";

/**
 * double-submit CSRF：
 * - 请求头 X-CSRF-Token 必须等于 kp_csrf Cookie（无 session 的登录前请求）；
 * - 有 session 时，还要与 session.csrf_hash 匹配（服务端绑定）。
 */
export function assertCsrf(request: FastifyRequest, session: SessionRow | null): string {
  const header = request.headers["x-csrf-token"];
  const cookie = request.cookies?.[CSRF_COOKIE];

  if (typeof header !== "string" || header.length === 0 || !cookie || header !== cookie) {
    throw new HttpProblem(403, "csrf_invalid", "CSRF token mismatch");
  }

  if (session && sha256(cookie) !== session.csrf_hash) {
    throw new HttpProblem(403, "csrf_invalid", "CSRF token mismatch");
  }

  return cookie;
}

/** 已登录接口的守卫：没有 session 直接 401。 */
export function requireAuth(request: FastifyRequest) {
  if (!request.auth) {
    throw new HttpProblem(401, "auth_required", "需要登录");
  }
  return request.auth;
}
