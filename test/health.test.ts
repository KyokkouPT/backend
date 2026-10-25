import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("GET /api/v1/health", () => {
  it("returns the contract payload", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/health` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({
      ok: true,
      service: "kyokkoupt-backend",
      version: "0.1.0",
    });
  });
});
