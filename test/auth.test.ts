import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import {
  createTestContext,
  login,
  setCookieValues,
  TEST_PASSWORD,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("auth / csrf", () => {
  it("issues a csrf cookie and token", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { csrf_token: string };
    expect(body.csrf_token).toBeTruthy();
    expect(setCookieValues(res.headers).get("kp_csrf")).toBe(body.csrf_token);
    expect(res.headers["set-cookie"]?.toString().toLowerCase()).not.toContain("httponly");
  });

  it("rejects login without csrf", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      payload: { username: "lightbringer", password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect((res.json() as { code: string }).code).toBe("csrf_invalid");
  });

  it("rejects a wrong password with problem+json", async () => {
    const csrfRes = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
    const csrfToken = setCookieValues(csrfRes.headers).get("kp_csrf") ?? "";

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie: `kp_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
      payload: { username: "lightbringer", password: "definitely-wrong" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect((res.json() as { code: string }).code).toBe("invalid_credentials");
  });

  it("does not reveal whether the account exists", async () => {
    const csrfRes = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
    const csrfToken = setCookieValues(csrfRes.headers).get("kp_csrf") ?? "";

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie: `kp_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
      payload: { username: "no-such-user", password: "whatever-123" },
    });

    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe("invalid_credentials");
  });

  it("logs in, sets an httpOnly session, and returns the user", async () => {
    const csrfRes = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
    const csrfToken = setCookieValues(csrfRes.headers).get("kp_csrf") ?? "";

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie: `kp_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
      payload: { username: "lightbringer", password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { username: string; role: string }; csrf_token: string };
    expect(body.user.username).toBe("lightbringer");
    expect(body.user.role).toBe("admin");
    expect(body.csrf_token).toBeTruthy();

    const setCookie = setCookieValues(res.headers);
    expect(setCookie.get("kp_session")).toBeTruthy();
    expect(setCookie.get("kp_csrf")).toBe(body.csrf_token);
    expect(res.headers["set-cookie"]?.toString().toLowerCase()).toContain("httponly");
    expect(res.headers["set-cookie"]?.toString().toLowerCase()).toContain("samesite=lax");
  });

  it("returns /auth/me after login and rejects anonymous", async () => {
    const anonymous = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/me` });
    expect(anonymous.statusCode).toBe(401);

    const session = await login(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: session.cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: { username: string };
      permissions: string[];
      todo: { pending_review: number };
    };
    expect(body.user.username).toBe("lightbringer");
    expect(body.permissions).toContain("staff.access");
    expect(typeof body.todo.pending_review).toBe("number");
  });

  it("requires csrf for logout and clears the session", async () => {
    const session = await login(ctx.app);

    const withoutCsrf = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/logout`,
      headers: { cookie: session.cookieHeader },
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const logout = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/logout`,
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
    });
    expect(logout.statusCode).toBe(200);

    const me = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/auth/me`,
      headers: { cookie: session.cookieHeader },
    });
    expect(me.statusCode).toBe(401);
  });

  it("refuses login for a banned user", async () => {
    await ctx.db
      .updateTable("users")
      .set({ status: "banned" })
      .where("username", "=", "axue")
      .execute();

    const csrfRes = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
    const csrfToken = setCookieValues(csrfRes.headers).get("kp_csrf") ?? "";

    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie: `kp_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
      payload: { username: "axue", password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe("invalid_credentials");

    await ctx.db.updateTable("users").set({ status: "active" }).where("username", "=", "axue").execute();
  });
});
