import type { Db } from "../db/db.js";

export const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

export const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "system",
  "support",
  "staff",
  "owner",
  "moderator",
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export type UsernameValidation =
  | { ok: true; username: string }
  | { ok: false; code: string; message: string };

export function validateUsername(
  input: string,
  options: { allowAdmin?: boolean } = {},
): UsernameValidation {
  const username = normalizeUsername(input);
  if (username.length < 3 || username.length > 32) {
    return { ok: false, code: "invalid_username", message: "用户名长度必须为 3–32 个字符" };
  }
  if (!/^[a-z0-9_-]+$/.test(username)) {
    return {
      ok: false,
      code: "invalid_username",
      message: "用户名只能包含小写字母、数字、下划线和连字符",
    };
  }
  if (!/[a-z0-9]/.test(username)) {
    return { ok: false, code: "invalid_username", message: "用户名必须包含字母或数字" };
  }
  if (RESERVED_USERNAMES.has(username) && !(options.allowAdmin && username === "admin")) {
    return { ok: false, code: "username_reserved", message: "该用户名为保留名" };
  }
  return { ok: true, username };
}

export async function isUsernameAvailable(
  db: Db,
  username: string,
  exceptUserId?: number,
): Promise<boolean> {
  let query = db.selectFrom("users").select("id").where("username", "=", username);
  if (exceptUserId !== undefined) query = query.where("id", "!=", exceptUserId);
  const row = await query.executeTakeFirst();
  return !row;
}

/** 生成迁移用的合法用户名；冲突时追加 _2、_3，并保证长度 ≤32。 */
export function migrationUsername(
  raw: string,
  id: number,
  taken: Set<string>,
): string {
  const lower = normalizeUsername(raw);
  let base = USERNAME_PATTERN.test(lower) ? lower : `user${String(id)}`;
  if (!USERNAME_PATTERN.test(base)) base = `user${String(id)}`;
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `_${String(suffix)}`;
    const candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `user${String(id)}`;
}
