import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
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
  user = await login(ctx.app, "axue", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

async function userRow(username: string) {
  return ctx.db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirstOrThrow();
}

async function csrfPair(): Promise<{ cookie: string; token: string }> {
  const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
  const token = setCookieValues(res.headers).get("kp_csrf") ?? "";
  return { cookie: `kp_csrf=${token}`, token };
}

describe("invites", () => {
  it("previews a seeded invite and generates a new one", async () => {
    const preview = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/invites/KYKDEMO1`,
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { valid: boolean }).valid).toBe(true);

    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/invites`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { code: string; status: string };
    expect(body.code.length).toBeGreaterThan(5);
    expect(body.status).toBe("unused");

    const list = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/invites`,
      headers: { cookie: admin.cookieHeader },
    });
    const listBody = list.json() as { items: { code: string }[]; quota_total: number };
    expect(listBody.items.some((item) => item.code === body.code)).toBe(true);
    expect(listBody.quota_total).toBe(4);
  });

  it("signs up with an invite, marks it used, and notifies the inviter", async () => {
    const generated = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/invites`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    const code = (generated.json() as { code: string }).code;

    const { cookie, token } = await csrfPair();
    const signup = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "newbie",
        email: "newbie@example.com",
        password: "newbie-pass-123",
        rules_accepted: true,
        invite_code: code,
      },
    });

    expect(signup.statusCode).toBe(201);
    const body = signup.json() as { user: { username: string; role: string } };
    expect(body.user.username).toBe("newbie");
    expect(body.user.role).toBe("user");
    expect(setCookieValues(signup.headers).get("kp_session")).toBeTruthy();

    const invite = await ctx.db
      .selectFrom("invites")
      .selectAll()
      .where("code", "=", code)
      .executeTakeFirstOrThrow();
    expect(invite.status).toBe("used");
    expect(Number(invite.invited_user_id)).toBeGreaterThan(0);

    const notifications = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications`,
      headers: { cookie: admin.cookieHeader },
    });
    const items = (notifications.json() as { items: { kind: string }[] }).items;
    expect(items.some((item) => item.kind === "invite")).toBe(true);
  });

  it("can require and enforce pre-registered invite email and username", async () => {
    const enable = await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        registration: { invite_require_email: true, invite_require_username: true },
      },
    });
    expect(enable.statusCode).toBe(200);

    const missingEmail = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/invites`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(missingEmail.statusCode).toBe(400);
    expect((missingEmail.json() as { code: string }).code).toBe("invite_email_required");

    const generated = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/invites`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { email: "invitee@example.com", username: "invitee" },
    });
    expect(generated.statusCode).toBe(201);
    const generatedBody = generated.json() as {
      code: string;
      email: string | null;
      username: string | null;
    };
    expect(generatedBody.email).toBe("invitee@example.com");
    expect(generatedBody.username).toBe("invitee");

    const preview = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/invites/${generatedBody.code}`,
    });
    expect((preview.json() as { email: string; username: string }).email).toBe(
      "invitee@example.com",
    );
    expect((preview.json() as { email: string; username: string }).username).toBe("invitee");

    const { cookie, token } = await csrfPair();
    const mismatch = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "invitee",
        email: "wrong@example.com",
        password: "invitee-pass-123",
        rules_accepted: true,
        invite_code: generatedBody.code,
      },
    });
    expect(mismatch.statusCode).toBe(400);
    expect((mismatch.json() as { code: string }).code).toBe("invite_email_mismatch");

    const wrongUsername = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "wrongname",
        email: "invitee@example.com",
        password: "invitee-pass-123",
        rules_accepted: true,
        invite_code: generatedBody.code,
      },
    });
    expect(wrongUsername.statusCode).toBe(400);
    expect((wrongUsername.json() as { code: string }).code).toBe("invite_username_mismatch");

    const signup = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "invitee",
        email: "invitee@example.com",
        password: "invitee-pass-123",
        rules_accepted: true,
        invite_code: generatedBody.code,
      },
    });
    expect(signup.statusCode).toBe(201);

    await ctx.app.inject({
      method: "PUT",
      url: `${API_PREFIX}/staff/settings`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { registration: { invite_require_email: false, invite_require_username: false } },
    });
  });

  it("rejects duplicate accounts, bad invites and missing csrf", async () => {
    const { cookie, token } = await csrfPair();
    const duplicate = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "newbie",
        email: "other@example.com",
        password: "newbie-pass-123",
        rules_accepted: true,
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const badInvite = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        username: "other",
        email: "other@example.com",
        password: "newbie-pass-123",
        rules_accepted: true,
        invite_code: "NOPE",
      },
    });
    expect(badInvite.statusCode).toBe(400);

    const noCsrf = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/signup`,
      payload: {
        username: "other2",
        email: "other2@example.com",
        password: "newbie-pass-123",
        rules_accepted: true,
      },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("requests", () => {
  it("lists open requests", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/requests` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { title: string; status: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => ["open", "fulfilled", "cancelled"].includes(item.status))).toBe(true);
  });

  it("escrows bounty on publish and refunds on cancel", async () => {
    const before = await userRow("lightbringer");
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { title: "求测试发布与取消", bounty: 500 },
    });
    expect(created.statusCode).toBe(201);

    const after = await userRow("lightbringer");
    expect(Number(before.bonus) - Number(after.bonus)).toBe(500);

    const list = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/requests` });
    const item = (list.json() as { items: { id: number; title: string }[] }).items.find(
      (entry) => entry.title === "求测试发布与取消",
    );
    expect(item).toBeTruthy();

    const cancel = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests/${String(item?.id)}/cancel`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);

    const refunded = await userRow("lightbringer");
    expect(Number(refunded.bonus)).toBe(Number(before.bonus));
  });

  it("rejects invalid bounty and non-owner cancel", async () => {
    const low = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: { title: "悬赏过低", bounty: 1 },
    });
    expect(low.statusCode).toBe(400);
    expect((low.json() as { code: string }).code).toBe("invalid_bounty");

    const seedRequest = await ctx.db
      .selectFrom("requests")
      .select("id")
      .where("title", "=", "求 4K 原盘《沙丘 2》国配版")
      .executeTakeFirstOrThrow();

    const notOwner = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests/${String(seedRequest.id)}/cancel`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: {},
    });
    expect(notOwner.statusCode).toBe(403);
  });

  it("lets staff settle a bounty to a deliverer", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { title: "求 Staff 结算演示", bounty: 500 },
    });
    expect(created.statusCode).toBe(201);

    const list = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/requests` });
    const item = (list.json() as { items: { id: number; title: string }[] }).items.find(
      (entry) => entry.title === "求 Staff 结算演示",
    );

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests/${String(item?.id)}/fulfill`,
      headers: { cookie: user.cookieHeader, "x-csrf-token": user.csrfToken },
      payload: { username: "axue" },
    });
    expect(forbidden.statusCode).toBe(403);

    const before = await userRow("axue");
    const fulfilled = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/requests/${String(item?.id)}/fulfill`,
      headers: { cookie: root.cookieHeader, "x-csrf-token": root.csrfToken },
      payload: { username: "axue" },
    });
    expect(fulfilled.statusCode).toBe(200);
    expect((fulfilled.json() as { status: string }).status).toBe("fulfilled");

    const after = await userRow("axue");
    expect(Number(after.bonus) - Number(before.bonus)).toBe(500);

    const row = await ctx.db
      .selectFrom("requests")
      .select(["status", "fulfilled_by"])
      .where("id", "=", Number(item?.id))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("fulfilled");
    expect(Number(row.fulfilled_by)).toBe(Number(after.id));
  });
});

describe("top and public profiles", () => {
  it("returns ranked user and torrent boards", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/top` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      users: { uploaded: { rank: number; username: string }[]; bonus: unknown[]; seedtime: unknown[] };
      torrents: { seeders: { rank: number }[]; completed: { rank: number }[] };
    };
    expect(body.users.uploaded.length).toBeGreaterThanOrEqual(2);
    expect(body.users.uploaded[0]?.rank).toBe(1);
    expect(body.users.bonus.length).toBeGreaterThanOrEqual(1);
    expect(body.torrents.seeders[0]?.rank).toBe(1);
    expect(body.torrents.completed.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a public profile without sensitive fields", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/users/lightbringer`,
    });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw.includes("password_hash")).toBe(false);
    expect(raw.includes("passkey")).toBe(false);
    expect(raw.includes("email")).toBe(false);

    const body = res.json() as {
      name: string;
      published_count: number;
      published_visible: boolean;
      published: unknown[];
    };
    expect(body.name).toBe("lightbringer");
    expect(body.published_count).toBeGreaterThanOrEqual(1);
    expect(body.published_visible).toBe(true);
    expect(body.published.length).toBeGreaterThanOrEqual(1);

    const missing = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/users/nobody` });
    expect(missing.statusCode).toBe(404);
  });

  it("respects public_published privacy preference", async () => {
    await ctx.db
      .updateTable("user_preferences")
      .set({ public_published: 0 })
      .where("user_id", "=", Number((await userRow("lightbringer")).id))
      .execute();

    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/users/lightbringer` });
    const body = res.json() as { published_visible: boolean; published: unknown[] };
    expect(body.published_visible).toBe(false);
    expect(body.published).toEqual([]);

    await ctx.db
      .updateTable("user_preferences")
      .set({ public_published: 1 })
      .where("user_id", "=", Number((await userRow("lightbringer")).id))
      .execute();
  });
});
