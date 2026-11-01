import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { createDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";

describe("migrations", () => {
  it("applies once and is idempotent", async () => {
    const db = createDb({ driver: "sqlite", url: ":memory:" });
    try {
      const first = await runMigrations(db, "sqlite");
      expect(first.length).toBeGreaterThan(0);
      expect(first[0]?.version).toBe(1);

      const second = await runMigrations(db, "sqlite");
      expect(second).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("creates the expected baseline tables", async () => {
    const db = createDb({ driver: "sqlite", url: ":memory:" });
    try {
      await runMigrations(db, "sqlite");
      const rows = await db
        .selectFrom("schema_migrations")
        .select(["version", "name"])
        .execute();
      expect(rows).toEqual([
        { version: 1, name: "init" },
        { version: 2, name: "notifications" },
        { version: 3, name: "tracker" },
        { version: 4, name: "economy" },
        { version: 5, name: "community" },
        { version: 6, name: "twofa" },
        { version: 7, name: "moderation" },
        { version: 8, name: "classes" },
        { version: 9, name: "class_simulator" },
        { version: 10, name: "raw_traffic" },
      ]);

      const users = await db.selectFrom("users").selectAll().execute();
      expect(users).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

describe("seed", () => {
  it("seeds demo data and is idempotent", async () => {
    const db = createDb({ driver: "sqlite", url: ":memory:" });
    try {
      await runMigrations(db, "sqlite");

      const first = await seedDatabase(db, { password: "test-password-123" });
      expect(first.users).toBe(3);
      expect(first.sections).toBe(6);
      expect(first.categories).toBe(23);
      expect(first.torrents).toBe(8);

      const second = await seedDatabase(db, { password: "test-password-123" });
      expect(second.users).toBe(0);
      expect(second.sections).toBe(0);
      expect(second.categories).toBe(0);
      expect(second.torrents).toBe(0);

      const userCount = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirst();
      expect(Number(userCount?.count)).toBe(3);

      const torrentCount = await db
        .selectFrom("torrents")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("status", "=", "approved")
        .executeTakeFirst();
      expect(Number(torrentCount?.count)).toBe(8);
    } finally {
      await db.destroy();
    }
  });
});

describe("password hashing", () => {
  it("stores scrypt and verifies without accepting wrong input", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash.startsWith("scrypt$1$")).toBe(true);
    expect(hash).not.toContain("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });
});
