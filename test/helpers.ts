import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";

export const TEST_PASSWORD = "test-password-123";

export type TestContext = {
  db: Db;
  app: FastifyInstance;
  password: string;
};

export async function createTestContext(options: { seed?: boolean } = {}): Promise<TestContext> {
  const db = createDb({ driver: "sqlite", url: ":memory:" });
  await runMigrations(db, "sqlite");

  if (options.seed !== false) {
    await seedDatabase(db, { password: TEST_PASSWORD });
  }

  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SEED_PASSWORD: TEST_PASSWORD,
    DATABASE_DRIVER: "sqlite",
    DATABASE_URL: ":memory:",
  });

  const app = buildApp({ db, config });
  await app.ready();

  return { db, app, password: TEST_PASSWORD };
}

export function setCookieValues(headers: {
  [key: string]: string | string[] | number | undefined;
}): Map<string, string> {
  const raw = headers["set-cookie"];
  const list = !raw ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
  const output = new Map<string, string>();

  for (const header of list) {
    const pair = header.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0) output.set(pair.slice(0, index), pair.slice(index + 1));
  }

  return output;
}

export type LoggedIn = {
  cookieHeader: string;
  csrfToken: string;
  userId: number;
  username: string;
};

export async function login(
  app: FastifyInstance,
  username = "lightbringer",
  password = TEST_PASSWORD,
): Promise<LoggedIn> {
  const csrfRes = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
  const csrfCookies = setCookieValues(csrfRes.headers);
  const csrfToken = csrfCookies.get("kp_csrf");
  if (!csrfToken) throw new Error("csrf cookie missing");

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { cookie: `kp_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
    payload: { username, password },
  });

  if (loginRes.statusCode !== 200) {
    throw new Error(`login failed: ${String(loginRes.statusCode)} ${loginRes.body}`);
  }

  const cookies = setCookieValues(loginRes.headers);
  const session = cookies.get("kp_session");
  const rotatedCsrf = cookies.get("kp_csrf");
  if (!session || !rotatedCsrf) throw new Error("session/csrf cookie missing after login");

  const body = loginRes.json() as { user: { id: number; username: string } };

  return {
    cookieHeader: `kp_session=${session}; kp_csrf=${rotatedCsrf}`,
    csrfToken: rotatedCsrf,
    userId: body.user.id,
    username: body.user.username,
  };
}
