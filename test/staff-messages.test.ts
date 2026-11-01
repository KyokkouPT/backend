import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let axue: LoggedIn;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app);
  axue = await login(ctx.app, "axue", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("staff mass messages", () => {
  async function waitJob(token: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `${API_PREFIX}/staff/messages/jobs/${token}`,
        headers: { cookie: admin.cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const job = res.json() as { status: string; recipients: number };
      if (job.status === "completed" || job.status === "failed") return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("message job did not finish");
  }

  it("returns target class options", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/staff/messages/options`,
      headers: { cookie: admin.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { classes: { slug: string; name: string }[] };
    expect(body.classes.length).toBeGreaterThan(0);
    expect(body.classes.some((item) => item.slug === "user")).toBe(true);
  });

  it("previews all active users when no filters are set", async () => {
    const active = await ctx.db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages/preview`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { title: "通知", body: "正文" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { recipients: number }).recipients).toBe(Number(active.count));
  });

  it("sends to an explicit user id and writes a notification", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        title: "指定用户通知",
        body: "这是一条群发测试。",
        user_ids: [axue.userId],
        link_url: "/me",
      },
    });
    expect(res.statusCode).toBe(200);
    const queued = res.json() as { job_token: string; status: string };
    expect(queued.status).toBe("queued");
    expect(queued.job_token.length).toBeGreaterThan(10);
    const job = await waitJob(queued.job_token);
    expect(job.status).toBe("completed");
    expect(job.recipients).toBe(1);

    const notifications = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications`,
      headers: { cookie: axue.cookieHeader },
    });
    const items = (notifications.json() as { items: { id: number; kind: string; title: string }[] }).items;
    const delivered = items.find(
      (item) => item.kind === "broadcast" && item.title === "指定用户通知",
    );
    expect(delivered).toBeTruthy();

    const detail = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications/${String(delivered?.id ?? 0)}`,
      headers: { cookie: axue.cookieHeader },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { read_at: number | null }).read_at).toBeNull();

    const read = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/notifications/${String(delivered?.id ?? 0)}/read`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
    });
    expect(read.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/notifications/${String(delivered?.id ?? 0)}`,
      headers: { cookie: axue.cookieHeader },
    });
    expect((after.json() as { read_at: number | null }).read_at).not.toBeNull();

    const audit = await ctx.db
      .selectFrom("audit_logs")
      .select("action")
      .where("action", "=", "staff.mass_message")
      .executeTakeFirst();
    expect(audit).toBeTruthy();
  });

  it("combines conditions and user groups", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages/preview`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: {
        title: "筛选通知",
        body: "正文",
        class_slugs: ["user"],
        conditions: {
          logic: "all",
          conditions: [{ metric: "bonus", op: ">=", value: 0 }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recipients: number; sample: string[] };
    expect(body.recipients).toBeGreaterThan(0);
    expect(body.sample.length).toBeGreaterThan(0);
  });

  it("rejects invalid links, unknown classes and non-staff accounts", async () => {
    const invalidLink = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages/preview`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { title: "通知", body: "正文", link_url: "javascript:alert(1)" },
    });
    expect(invalidLink.statusCode).toBe(400);
    expect((invalidLink.json() as { code: string }).code).toBe("invalid_link");

    const unknownClass = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages/preview`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { title: "通知", body: "正文", class_slugs: ["missing"] },
    });
    expect(unknownClass.statusCode).toBe(400);
    expect((unknownClass.json() as { code: string }).code).toBe("class_not_found");

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/messages/preview`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
      payload: { title: "通知", body: "正文" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
