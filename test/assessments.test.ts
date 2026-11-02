import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import {
  checkoutDueAssessments,
  updateActiveAssessments,
} from "../src/lib/assessments.js";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: LoggedIn;
let axue: LoggedIn;

const GB = 1024 ** 3;

function assessmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "测试任务",
    description_markdown: "完成上传增量",
    type: "task",
    status: "active",
    begin_at: null,
    end_at: null,
    duration_days: 30,
    recurring: "none",
    filters: {},
    requirements: {
      logic: "all",
      items: [{ metric: "uploaded_delta", op: ">=", value: 1, unit: "GB" }],
    },
    reward: { bonus: 100, invite: 0, class_slug: null, custom_title: null },
    penalty: { bonus: 50, invite: 0, warn: 0, class_slug: null, suspend_days: 0, ban: false },
    max_participants: 0,
    allow_concurrent: false,
    settle_early: true,
    ...overrides,
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await login(ctx.app);
  axue = await login(ctx.app, "axue", TEST_PASSWORD);
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("assessments", () => {
  it("creates, claims, tracks progress and settles early with reward", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/assessments`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: assessmentPayload({ filters: { user_ids: [axue.userId] } }),
    });
    expect(created.statusCode).toBe(201);
    const assessment = created.json() as { id: number };
    expect(assessment.id).toBeGreaterThan(0);

    const before = await ctx.db
      .selectFrom("users")
      .select("bonus")
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();

    const claimed = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/me/assessments/${String(assessment.id)}/claim`,
      headers: { cookie: axue.cookieHeader, "x-csrf-token": axue.csrfToken },
    });
    expect(claimed.statusCode).toBe(200);
    const assignment = claimed.json() as { id: number; status: string; progress: { target: number }[] };
    expect(assignment.status).toBe("claimed");
    expect(assignment.progress[0]?.target).toBe(1);

    const user = await ctx.db
      .selectFrom("users")
      .select("uploaded")
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("users")
      .set({ uploaded: Number(user.uploaded) + 2 * GB })
      .where("id", "=", axue.userId)
      .execute();

    await updateActiveAssessments(ctx.db);

    const settled = await ctx.db
      .selectFrom("assessment_assignments")
      .select(["status", "reward_applied", "penalty_applied"])
      .where("id", "=", assignment.id)
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe("passed");
    expect(Number(settled.reward_applied)).toBe(1);
    expect(Number(settled.penalty_applied)).toBe(0);

    const after = await ctx.db
      .selectFrom("users")
      .select("bonus")
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    expect(Number(after.bonus) - Number(before.bonus)).toBe(100);

    const ledger = await ctx.db
      .selectFrom("bonus_ledger")
      .select("kind")
      .where("user_id", "=", axue.userId)
      .where("ref_type", "=", "assessment_assignment")
      .executeTakeFirst();
    expect(ledger?.kind).toBe("assessment");
  });

  it("applies penalty when an assigned assessment expires", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/assessments`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: assessmentPayload({
        name: "过期考核",
        type: "exam",
        filters: { user_ids: [axue.userId] },
        requirements: {
          logic: "all",
          items: [{ metric: "uploaded_delta", op: ">=", value: 9999, unit: "GB" }],
        },
        reward: { bonus: 0, invite: 0, class_slug: null, custom_title: null },
        penalty: { bonus: 50, invite: 0, warn: 1, class_slug: null, suspend_days: 0, ban: false },
      }),
    });
    expect(created.statusCode).toBe(201);
    const assessment = created.json() as { id: number };

    const assigned = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/assessments/${String(assessment.id)}/assign`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { user_ids: [axue.userId] },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { assigned: number }).assigned).toBe(1);

    const assignment = await ctx.db
      .selectFrom("assessment_assignments")
      .select(["id", "status"])
      .where("assessment_id", "=", assessment.id)
      .where("user_id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("assessment_assignments")
      .set({ end_at: Date.now() - 1000 })
      .where("id", "=", assignment.id)
      .execute();

    const before = await ctx.db
      .selectFrom("users")
      .select(["bonus", "warnings"])
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();

    await checkoutDueAssessments(ctx.db);

    const settled = await ctx.db
      .selectFrom("assessment_assignments")
      .select(["status", "penalty_applied"])
      .where("id", "=", assignment.id)
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe("failed");
    expect(Number(settled.penalty_applied)).toBe(1);

    const after = await ctx.db
      .selectFrom("users")
      .select(["bonus", "warnings"])
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    expect(Number(after.bonus)).toBe(Math.max(0, Number(before.bonus) - 50));
    expect(Number(after.warnings)).toBe(Number(before.warnings) + 1);
  });

  it("applies suspension and records suspended_until", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/assessments`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: assessmentPayload({
        name: "停用处罚考核",
        type: "exam",
        requirements: {
          logic: "all",
          items: [{ metric: "uploaded_delta", op: ">=", value: 9999, unit: "GB" }],
        },
        reward: { bonus: 0, invite: 0, class_slug: null, custom_title: null },
        penalty: { bonus: 0, invite: 0, warn: 0, class_slug: null, suspend_days: 1, ban: false },
      }),
    });
    expect(created.statusCode).toBe(201);
    const assessment = created.json() as { id: number };
    await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/staff/assessments/${String(assessment.id)}/assign`,
      headers: { cookie: admin.cookieHeader, "x-csrf-token": admin.csrfToken },
      payload: { user_ids: [axue.userId] },
    });
    const assignment = await ctx.db
      .selectFrom("assessment_assignments")
      .select("id")
      .where("assessment_id", "=", assessment.id)
      .where("user_id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    await ctx.db
      .updateTable("assessment_assignments")
      .set({ end_at: Date.now() - 1000 })
      .where("id", "=", assignment.id)
      .execute();
    await checkoutDueAssessments(ctx.db);
    const user = await ctx.db
      .selectFrom("users")
      .select(["status", "suspended_until"])
      .where("id", "=", axue.userId)
      .executeTakeFirstOrThrow();
    expect(user.status).toBe("suspended");
    expect(Number(user.suspended_until)).toBeGreaterThan(Date.now());
  });

  it("lists the user's assignments and offers", async () => {
    const session = await login(ctx.app, "axue", TEST_PASSWORD);
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/me/assessments`,
      headers: { cookie: session.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; available: unknown[] };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.available)).toBe(true);
  });
});
