import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Selectable } from "kysely";
import type { Db } from "../db/db.js";
import type { ClassesTable, SessionsTable, UsersTable } from "../db/types.js";
import { computePermissions, loadClassById, loadClassBySlug, loadOverrides } from "../lib/classes.js";

export const SESSION_COOKIE = "kp_session";
export const CSRF_COOKIE = "kp_csrf";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRow = Selectable<SessionsTable>;
export type UserRow = Selectable<UsersTable>;
export type ClassRow = Selectable<ClassesTable>;

export type AuthContext = {
  session: SessionRow;
  user: UserRow;
  class: ClassRow | null;
  permissions: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    /** onRequest 钩子填充；未登录为 null。 */
    auth: AuthContext | null;
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function createSession(
  db: Db,
  userId: number,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
  const token = newToken();
  const csrfToken = newToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .insertInto("sessions")
    .values({
      user_id: userId,
      token_hash: sha256(token),
      csrf_hash: sha256(csrfToken),
      expires_at: expiresAt,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
      created_at: now,
    })
    .execute();

  return { token, csrfToken, expiresAt };
}

export async function resolveSessionByToken(db: Db, token: string): Promise<AuthContext | null> {
  const session = await db
    .selectFrom("sessions")
    .selectAll()
    .where("token_hash", "=", sha256(token))
    .executeTakeFirst();

  if (!session) return null;

  if (session.expires_at <= Date.now()) {
    await db.deleteFrom("sessions").where("id", "=", session.id).execute();
    return null;
  }

  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", session.user_id)
    .executeTakeFirst();

  // 封禁用户立即失效；停用用户可以登录，但权限为空。
  if (!user || user.status === "banned") {
    if (user) await db.deleteFrom("sessions").where("id", "=", session.id).execute();
    return null;
  }

  const classRow =
    user.class_id === null
      ? await loadClassBySlug(db, "user")
      : await loadClassById(db, Number(user.class_id));
  const overrides = await loadOverrides(db, Number(user.id));
  const permissions =
    user.status === "suspended" ? [] : computePermissions(classRow, overrides);

  return { session, user, class: classRow, permissions };
}

export async function deleteSession(db: Db, sessionId: number): Promise<void> {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function deleteAllSessionsOfUser(db: Db, userId: number): Promise<void> {
  await db.deleteFrom("sessions").where("user_id", "=", userId).execute();
}

export function cookieOptions(secure: boolean, maxAgeSeconds: number) {
  return {
    path: "/",
    sameSite: "lax" as const,
    secure,
    maxAge: maxAgeSeconds,
  };
}

/** onRequest 钩子：解析 Cookie 里的 session，失败静默为未登录。 */
export function createAuthHook(db: Db) {
  return async function attachAuth(request: FastifyRequest): Promise<void> {
    const token = request.cookies?.[SESSION_COOKIE];
    request.auth = token ? await resolveSessionByToken(db, token) : null;
  };
}
