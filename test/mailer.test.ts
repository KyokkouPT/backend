import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { createMailer, setMailer, type Mailer } from "../src/lib/mailer.js";
import { createNotification } from "../src/lib/notifications.js";
import { createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;

const sent: { to: string; subject: string; text: string }[] = [];

function fakeMailer(): Mailer {
  return {
    async send(mail) {
      sent.push(mail);
      return true;
    },
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  setMailer(null);
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("smtp config", () => {
  it("stays disabled without SMTP_HOST", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_SECRET: "x".repeat(40),
      SEED_PASSWORD: "test-password",
    });
    expect(config.smtp).toBeNull();
  });

  it("requires SMTP_FROM and paired credentials", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        SESSION_SECRET: "x".repeat(40),
        SEED_PASSWORD: "test-password",
        SMTP_HOST: "smtp.example.com",
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        SESSION_SECRET: "x".repeat(40),
        SEED_PASSWORD: "test-password",
        SMTP_HOST: "smtp.example.com",
        SMTP_FROM: "noreply@example.com",
        SMTP_USER: "noreply@example.com",
      }),
    ).toThrow(ConfigError);

    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_SECRET: "x".repeat(40),
      SEED_PASSWORD: "test-password",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
      SMTP_USER: "noreply@example.com",
      SMTP_PASS: "secret",
    });
    expect(config.smtp).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "noreply@example.com",
      pass: "secret",
      from: "noreply@example.com",
    });
  });
});

describe("mailer", () => {
  it("returns false instead of throwing when SMTP is unreachable", async () => {
    const warnings: unknown[] = [];
    const mailer = createMailer(
      {
        host: "127.0.0.1",
        port: 2526,
        secure: false,
        user: null,
        pass: null,
        from: "noreply@example.com",
      },
      { warn: (obj) => warnings.push(obj) },
    );

    const ok = await mailer.send({
      to: "user@example.com",
      subject: "hello",
      text: "body",
    });
    expect(ok).toBe(false);
    expect(warnings.length).toBe(1);
  });
});

describe("notification email preferences", () => {
  it("sends review emails when the preference is on", async () => {
    const user = await ctx.db
      .selectFrom("users")
      .selectAll()
      .where("username", "=", "lightbringer")
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("user_preferences")
      .set({ email_review: 1, email_social: 0 })
      .where("user_id", "=", Number(user.id))
      .execute();

    setMailer(fakeMailer());
    sent.length = 0;
    await createNotification(ctx.db, {
      userId: Number(user.id),
      kind: "review",
      title: "审核结果",
      body: "你的种子已通过。",
      linkUrl: "/notifications",
    });

    expect(sent.length).toBe(1);
    expect(sent[0]?.to).toBe(user.email);
    expect(sent[0]?.subject).toContain("审核结果");
    expect(sent[0]?.text).toContain("链接：/notifications");
  });

  it("does not send when the preference is off", async () => {
    const user = await ctx.db
      .selectFrom("users")
      .selectAll()
      .where("username", "=", "lightbringer")
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("user_preferences")
      .set({ email_social: 0 })
      .where("user_id", "=", Number(user.id))
      .execute();

    sent.length = 0;
    await createNotification(ctx.db, {
      userId: Number(user.id),
      kind: "social",
      title: "有人回复了你",
      body: "回复内容",
      linkUrl: null,
    });
    expect(sent.length).toBe(0);
  });

  it("skips banned users and unknown kinds", async () => {
    const user = await ctx.db
      .selectFrom("users")
      .selectAll()
      .where("username", "=", "axue")
      .executeTakeFirstOrThrow();

    await ctx.db.updateTable("users").set({ status: "banned" }).where("id", "=", user.id).execute();
    sent.length = 0;
    await createNotification(ctx.db, {
      userId: Number(user.id),
      kind: "invite",
      title: "邀请",
      body: "body",
    });
    expect(sent.length).toBe(0);

    await ctx.db.updateTable("users").set({ status: "active" }).where("id", "=", user.id).execute();
    await createNotification(ctx.db, {
      userId: Number(user.id),
      kind: "appeal",
      title: "申诉",
      body: "body",
    });
    expect(sent.length).toBe(0);
  });
});
