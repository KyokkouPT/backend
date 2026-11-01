import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "../config.js";
import { hashPassword } from "../auth/password.js";
import { createDb } from "./db.js";

/**
 * 重置指定用户名的密码（本地运维命令）。
 * 用法：
 *   pnpm reset-password username:new_password
 *
 * - 用户名不存在时提示「用户不存在」并退出码 1；
 * - 只更新该用户的 password_hash，并撤销其全部登录会话；
 * - 不修改角色/等级/其他资料。
 */
async function main(): Promise<void> {
  const raw = process.argv[2] ?? "";
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    console.error("用法：pnpm reset-password username:new_password");
    process.exitCode = 1;
    return;
  }

  const username = raw.slice(0, separator).trim().toLowerCase();
  const password = raw.slice(separator + 1);
  if (!username) {
    console.error("用户名不能为空");
    process.exitCode = 1;
    return;
  }
  if (password.length < 8 || password.length > 200) {
    console.error("密码长度需在 8-200 位之间");
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const db = createDb({ driver: config.databaseDriver, url: config.databaseUrl });
  try {
    const user = await db
      .selectFrom("users")
      .select(["id", "username"])
      .where("username", "=", username)
      .executeTakeFirst();

    if (!user) {
      console.error(`用户不存在：${username}`);
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(password);
    await db
      .updateTable("users")
      .set({ password_hash: passwordHash })
      .where("id", "=", Number(user.id))
      .execute();
    const sessions = await db
      .deleteFrom("sessions")
      .where("user_id", "=", Number(user.id))
      .execute();
    const revoked = Number(sessions[0]?.numDeletedRows ?? 0);

    console.log(`已重置用户 ${user.username} 的密码（撤销 ${String(revoked)} 个登录会话）。`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
