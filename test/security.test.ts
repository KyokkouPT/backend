import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { totpCode } from "../src/lib/totp.js";
import {
  createTestContext,
  login,
  setCookieValues,
  TEST_PASSWORD,
  type LoggedIn,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let root: LoggedIn;
let user: LoggedIn;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app, "lightbringer");
  root = await login(ctx.app, "root", TEST_PASSWORD);
  user = await login(ctx.app, "阿雪", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

async function csrfPair(): Promise<{ cookie: string; token: string }> {
  const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
  const token = setCookieValues(res.headers).get("kp_csrf") ?? "";
  return { cookie: `kp_csrf=${token}`, token };
}

async function userRow(username: string) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
}

describe("account settings", () => {
  it("returns settings and rotates passkey", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/settings`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { email: string; passkey: string; twofa_enabled: boolean };
    expect(body.email).toContain("@");
    expect(body.twofa_enabled).toBe(false);

    const rotate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/passkey/rotate`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = (rotate.json() as { passkey: string }).passkey;
    expect(rotated).not.toBe(body.passkey);
  });

  it("updates email and preferences", async () => {
    const emailRes = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/me/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { email: "lightbringer+new@example.com" },
    });
    expect(emailRes.statusCode).toBe(200);

    const pref = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/me/preferences`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { public_published: false },
    });
    expect(pref.statusCode).toBe(200);
    expect((pref.json() as { public_published: boolean }).public_published).toBe(false);

    const profile = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/users/lightbringer` });
    expect((profile.json() as { published_visible: boolean }).published_visible).toBe(false);

    await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/me/preferences`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { public_published: true },
    });
  });
});

describe("two-factor auth", () => {
  it("enables 2FA, requires codes, accepts recovery codes, and disables", async () => {
    const setup = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/2fa/setup`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { password: TEST_PASSWORD },
    });
    expect(setup.statusCode).toBe(200);
    const secret = (setup.json() as { secret: string }).secret;

    const enable = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/2fa/enable`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { code: totpCode(secret) },
    });
    expect(enable.statusCode).toBe(200);
    const recoveryCodes = (enable.json() as { recovery_codes: string[] }).recovery_codes;
    expect(recoveryCodes).toHaveLength(8);

    const { cookie, token } = await csrfPair();
    const withoutCode = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie, "x-csrf-token": token },
      payload: { username: "lightbringer", password: TEST_PASSWORD },
    });
    expect(withoutCode.statusCode).toBe(401);
    expect((withoutCode.json() as { code: string }).code).toBe("twofa_required");

    const withTotp = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie, "x-csrf-token": token },
      payload: { username: "lightbringer", password: TEST_PASSWORD, totp_code: totpCode(secret) },
    });
    expect(withTotp.statusCode).toBe(200);

    const recovery = recoveryCodes[0] ?? "";
    const withRecovery = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie, "x-csrf-token": token },
      payload: { username: "lightbringer", password: TEST_PASSWORD, recovery_code: recovery },
    });
    expect(withRecovery.statusCode).toBe(200);

    const reused = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie, "x-csrf-token": token },
      payload: { username: "lightbringer", password: TEST_PASSWORD, recovery_code: recovery },
    });
    expect(reused.statusCode).toBe(401);

    const disable = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/2fa/disable`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { password: TEST_PASSWORD },
    });
    expect(disable.statusCode).toBe(200);
  });
});

describe("staff moderation", () => {
  it("returns summary and searches users", async () => {
    const summary = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/summary`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as { open_reports: number; anomalies: number; schema_version: number };
    expect(body.open_reports).toBeGreaterThanOrEqual(1);
    expect(body.anomalies).toBeGreaterThanOrEqual(1);
    expect(body.schema_version).toBe(10);

    const search = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/users?q=阿雪`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { items: { username: string }[] }).items.some((item) => item.username === "阿雪")).toBe(true);
  });

  it("warns, suspends, bans and restores a user with session revocation", async () => {
    const target = await userRow("阿雪");

    const warn = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users/${String(target.id)}/warn`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { reason: "测试警告" },
    });
    expect(warn.statusCode).toBe(200);

    const suspend = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users/${String(target.id)}/suspend`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(suspend.statusCode).toBe(200);
    expect((await userRow("阿雪")).status).toBe("suspended");

    const meAfter = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me`,
      headers: { cookie: user.cookieHeader },
    });
    expect(meAfter.statusCode).toBe(401);

    const self = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users/${String((await userRow("lightbringer")).id)}/ban`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(self.statusCode).toBe(400);

    await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/users/${String(target.id)}/restore`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect((await userRow("阿雪")).status).toBe("active");

    const audit = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/audit`,
      headers: { cookie: admin.cookieHeader },
    });
    const items = (audit.json() as { items: { action: string }[] }).items;
    expect(items.some((item) => item.action === "user.suspend")).toBe(true);

    const csv = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/audit/export`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
  });

  it("resolves reports and notifies the reporter", async () => {
    const freshUser = await login(ctx.app, "阿雪", TEST_PASSWORD);
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/reports`,
      headers: { cookie: freshUser.cookieHeader, "x-csrf-token": freshUser.csrfToken },
      payload: { target_type: "torrent", target_id: "1", reason: "naming", detail: "标题命名不规范" },
    });
    expect(created.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/reports?status=open`,
      headers: { cookie: admin.cookieHeader },
    });
    const items = (list.json() as { items: { id: number; status: string }[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    const resolve = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/reports/${String(items[0]?.id)}/resolve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { action: "resolve", reason: "已按规范修改" },
    });
    expect(resolve.statusCode).toBe(200);
  });

  it("freezes bonus and bans from the anomaly queue", async () => {
    const anomalies = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/anomalies`,
      headers: { cookie: admin.cookieHeader },
    });
    const item = (anomalies.json() as { items: { id: number; user: { name: string } }[] }).items[0];
    expect(item).toBeTruthy();

    const freeze = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/anomalies/${String(item?.id)}/resolve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { action: "freeze", days: 7 },
    });
    expect(freeze.statusCode).toBe(200);

    const frozen = await userRow(item?.user.name ?? "");
    expect(Number(frozen.bonus_frozen_until)).toBeGreaterThan(Date.now());
  });
});

describe("appeals", () => {
  it("accepts a bonus freeze appeal", async () => {
    const appeals = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/appeals?status=open`,
      headers: { cookie: admin.cookieHeader },
    });
    const item = (appeals.json() as { items: { id: number; kind: string; user: { name: string } }[] }).items.find(
      (appeal) => appeal.kind === "bonus_freeze",
    );
    expect(item).toBeTruthy();

    const accept = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/appeals/${String(item?.id)}/resolve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { action: "accept", note: "已复核解除" },
    });
    expect(accept.statusCode).toBe(200);

    const row = await ctx.db
      .selectFrom("appeals")
      .select("status")
      .where("id", "=", Number(item?.id))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("accepted");
  });

  it("supports public ban appeals and staff restoration", async () => {
    const target = await userRow("阿雪");
    await ctx.db.updateTable("users").set({ status: "banned" }).where("id", "=", target.id).execute();

    const { cookie, token } = await csrfPair();
    const publicAppeal = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/appeals/public`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "阿雪",
        email: target.email,
        password: TEST_PASSWORD,
        reason: "封禁前没有异常行为，请复核这次封禁。",
      },
    });
    expect(publicAppeal.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/appeals?status=open`,
      headers: { cookie: admin.cookieHeader },
    });
    const banAppeal = (list.json() as { items: { id: number; kind: string }[] }).items.find(
      (appeal) => appeal.kind === "ban",
    );
    expect(banAppeal).toBeTruthy();

    const accept = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/appeals/${String(banAppeal?.id)}/resolve`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { action: "accept", note: "恢复账号" },
    });
    expect(accept.statusCode).toBe(200);
    expect((await userRow("阿雪")).status).toBe("active");
  });

  it("lets a user submit, comment and withdraw an appeal", async () => {
    const fresh = await login(ctx.app, "阿雪", TEST_PASSWORD);
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/appeals`,
      headers: { cookie: fresh.cookieHeader, "x-csrf-token": fresh.csrfToken },
      payload: { kind: "other", reason: "测试提交的申诉，用于验证撤回流程。" },
    });
    expect(created.statusCode).toBe(201);

    const mine = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/appeals`,
      headers: { cookie: fresh.cookieHeader },
    });
    const appeal = (mine.json() as { items: { id: number; status: string }[] }).items.find(
      (entry) => entry.status === "open",
    );
    expect(appeal).toBeTruthy();

    const comment = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/appeals/${String(appeal?.id)}/messages`,
      headers: { cookie: fresh.cookieHeader, "x-csrf-token": fresh.csrfToken },
      payload: { body: "补充说明" },
    });
    expect(comment.statusCode).toBe(200);

    const withdraw = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/appeals/${String(appeal?.id)}/withdraw`,
      headers: { cookie: fresh.cookieHeader, "x-csrf-token": fresh.csrfToken },
      payload: {},
    });
    expect(withdraw.statusCode).toBe(200);
  });
});
