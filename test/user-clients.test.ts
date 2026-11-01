import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";

let ctx: TestContext;
let axue: LoggedIn;
let axueId = 0;

const PEER_ID = "PEERCLIENT0123456789";

function peerIdHex(): string {
  return Buffer.from(PEER_ID, "ascii").toString("hex");
}

beforeAll(async () => {
  ctx = await createTestContext();
  axue = await login(ctx.app, "axue", TEST_PASSWORD);
  axueId = axue.userId;
  const now = Date.now();

  await ctx.db
    .insertInto("peers")
    .values([
      {
        torrent_id: 2,
        user_id: axueId,
        peer_id_hex: peerIdHex(),
        ip: "10.2.25.105",
        port: 32763,
        left_bytes: 0,
        seeder: 1,
        last_seen: now,
        created_at: 1000,
      },
      {
        torrent_id: 1,
        user_id: axueId,
        peer_id_hex: peerIdHex(),
        ip: "2001:db8::105",
        port: 32764,
        left_bytes: 100,
        seeder: 0,
        last_seen: now - 1000,
        created_at: 2000,
      },
    ])
    .execute();
});

afterAll(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

describe("public user clients", () => {
  it("groups IPv4/IPv6 peers into one BT client", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/users/${String(axueId)}/clients`,
      headers: { cookie: axue.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hidden: boolean;
      items: {
        client_code: string | null;
        ipv4: string | null;
        ipv6: string | null;
        features: string;
        seeding: number;
        leeching: number;
        started_at: number;
      }[];
    };
    expect(body.hidden).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.client_code).toBe("PEERCLIE");
    expect(body.items[0]?.ipv4).toBe("10.2.25.105:32763");
    expect(body.items[0]?.ipv6).toBe("[2001:db8::105]:32764");
    expect(body.items[0]?.features).toBe("4&6");
    expect(body.items[0]?.seeding).toBe(1);
    expect(body.items[0]?.leeching).toBe(1);
    expect(body.items[0]?.started_at).toBe(1000);
  });

  it("loads the numeric-id profile and includes bonus", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/users/id/${String(axueId)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; bonus: number };
    expect(body.name).toBe("axue");
    expect(typeof body.bonus).toBe("number");
  });

  it("hides clients from guests when public seeding is disabled but still shows them to self", async () => {
    await ctx.db
      .updateTable("user_preferences")
      .set({ public_seeding: 0 })
      .where("user_id", "=", axueId)
      .execute();

    const guest = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/users/${String(axueId)}/clients`,
    });
    expect(guest.statusCode).toBe(200);
    expect((guest.json() as { hidden: boolean }).hidden).toBe(true);

    const self = await ctx.app.inject({
      method: "GET",
      url: `${API_PREFIX}/users/${String(axueId)}/clients`,
      headers: { cookie: axue.cookieHeader },
    });
    expect((self.json() as { hidden: boolean }).hidden).toBe(false);
  });
});
