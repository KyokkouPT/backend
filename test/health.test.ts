import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { API_PREFIX } from "@kyokkou/contracts";

const app = buildApp();

afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/health", () => {
  it("returns the contract payload", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/health` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({
      ok: true,
      service: "kyokkoupt-backend",
      version: "0.1.0",
    });
  });
});
