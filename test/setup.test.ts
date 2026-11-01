import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, setCookieValues, type TestContext } from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ seed: false });
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

describe("setup wizard", () => {
  it("reports requires_setup on an empty database", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/setup/status` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { requires_setup: boolean }).requires_setup).toBe(true);
  });

  it("installs the site with an admin, settings and sections", async () => {
    const { cookie, token } = await csrfPair();
    const res = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/setup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        site_name: "My PT",
        site_tagline: "test site",
        admin_username: "admin",
        admin_email: "admin@example.com",
        admin_password: "owner-pass-123",
        base_sections: true,
        registration_open: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { username: string; role: string } };
    expect(body.user.username).toBe("admin");
    expect(body.user.role).toBe("admin");
    expect(setCookieValues(res.headers).get("kp_session")).toBeTruthy();

    const status = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/setup/status` });
    expect((status.json() as { requires_setup: boolean }).requires_setup).toBe(false);

    const install = await ctx.db.selectFrom("instance_meta").selectAll().execute();
    expect(install).toHaveLength(1);
    expect(install[0]?.install_state).toBe("ready");

    const sections = await ctx.db.selectFrom("sections").selectAll().execute();
    expect(sections).toHaveLength(6);

    const settings = await ctx.db.selectFrom("site_settings").selectAll().execute();
    expect(settings).toHaveLength(2);
  });

  it("rejects a second install and lets the new admin log in", async () => {
    const { cookie, token } = await csrfPair();
    const again = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/setup`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        site_name: "x",
        admin_username: "x",
        admin_email: "x@example.com",
        admin_password: "x-pass-123",
        base_sections: false,
        registration_open: true,
      },
    });
    expect(again.statusCode).toBe(409);

    const login = await ctx.app.inject({
      method: "POST",
      url: `${API_PREFIX}/auth/login`,
      headers: { cookie, "x-csrf-token": token },
      payload: { username: "admin", password: "owner-pass-123" },
    });
    expect(login.statusCode).toBe(200);
  });
});
