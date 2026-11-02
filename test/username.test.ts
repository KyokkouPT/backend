import { describe, expect, it } from "vitest";
import { API_PREFIX } from "@kyokkou/contracts";
import { createTestContext, login, TEST_PASSWORD, type LoggedIn, type TestContext } from "./helpers.js";
import { createDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { migrations } from "../src/db/migrations/index.js";
import { seedDatabase } from "../src/db/seed.js";
import {
  migrationUsername,
  normalizeUsername,
  validateUsername,
} from "../src/lib/username.js";
import { applyUsernameChange, UsernameChangeError } from "../src/lib/username-change.js";

describe("username rules", () => {
  it("normalizes and validates ASCII usernames", () => {
    expect(normalizeUsername("  Alice ")).toBe("alice");
    expect(validateUsername("Alice")).toEqual({ ok: true, username: "alice" });
    expect(validateUsername("ab").ok).toBe(false);
    expect(validateUsername("a".repeat(33)).ok).toBe(false);
    expect(validateUsername("阿雪").ok).toBe(false);
    expect(validateUsername("bad name").ok).toBe(false);
    expect(validateUsername("bad.name").ok).toBe(false);
    expect(validateUsername("___").ok).toBe(false);
  });

  it("only allows admin when explicitly permitted", () => {
    expect(validateUsername("admin").ok).toBe(false);
    expect(validateUsername("admin", { allowAdmin: true })).toEqual({
      ok: true,
      username: "admin",
    });
    expect(validateUsername("root").ok).toBe(false);
    expect(validateUsername("root", { allowAdmin: true }).ok).toBe(false);
  });

  it("generates deterministic migration names with suffixes", () => {
    const taken = new Set<string>();
    expect(migrationUsername("阿雪", 3, taken)).toBe("user3");
    taken.add("user3");
    expect(migrationUsername("阿雪", 4, taken)).toBe("user4");
    taken.clear();
    taken.add("alice");
    expect(migrationUsername("Alice", 1, taken)).toBe("alice_2");
  });
});

describe("username change service", () => {
  let ctx: TestContext;

  it("renames, enforces cooldown and refunds a revert", async () => {
    ctx = await createTestContext();
    try {
      const user = await ctx.db
        .selectFrom("users")
        .select(["id", "bonus"])
        .where("username", "=", "axue")
        .executeTakeFirstOrThrow();
      const userId = Number(user.id);
      await ctx.db
        .updateTable("users")
        .set({ username: "axue", username_changed_at: null, bonus: 100 })
        .where("id", "=", userId)
        .execute();

      const first = await applyUsernameChange(ctx.db, {
        userId,
        newUsername: "axue_new",
        price: 50,
      });
      expect(first.username).toBe("axue_new");
      const reservation = await ctx.db
        .selectFrom("username_reservations")
        .select(["username", "released_at"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(reservation.username).toBe("axue");
      expect(reservation.released_at).toBeNull();

      await expect(
        applyUsernameChange(ctx.db, { userId, newUsername: "axue_other", price: 50 }),
      ).rejects.toBeInstanceOf(UsernameChangeError);

      const revert = await applyUsernameChange(ctx.db, {
        userId,
        newUsername: "axue",
        price: 50,
      });
      expect(revert.reverted).toBe(true);
      expect(revert.refund).toBe(50);

      const after = await ctx.db
        .selectFrom("users")
        .select(["username", "bonus"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(after.username).toBe("axue");
      expect(Number(after.bonus)).toBe(100);
    } finally {
      await ctx.app.close();
      await ctx.db.destroy();
    }
  });
});

describe("username migration", () => {
  it("normalizes legacy names, resolves duplicates and migrates permissions", async () => {
    const db = createDb({ driver: "sqlite", url: ":memory:" });
    try {
      await runMigrations(db, "sqlite", migrations.filter((item) => item.version < 14));
      // 旧库测试只跑到 013，但 seed 会写入后续迁移新增的列。
      await db.schema
        .alterTable("users")
        .addColumn("seed_points", "double precision", (col) => col.notNull().defaultTo(0))
        .execute();
      await seedDatabase(db, { password: TEST_PASSWORD });
      await db.updateTable("users").set({ username: "Alice" }).where("username", "=", "lightbringer").execute();
      await db.updateTable("users").set({ username: "alice" }).where("username", "=", "root").execute();
      await db.updateTable("users").set({ username: "阿雪" }).where("username", "=", "axue").execute();

      const staffClass = await db.selectFrom("classes").select("id").where("slug", "=", "staff").executeTakeFirstOrThrow();
      const userRow = await db.selectFrom("users").select("id").where("username", "=", "阿雪").executeTakeFirstOrThrow();
      await db
        .insertInto("user_permission_overrides")
        .values({
          user_id: Number(userRow.id),
          permission: "staff.user_edit",
          effect: "grant",
          expires_at: null,
          actor_id: null,
          created_at: Date.now(),
        })
        .execute();
      await db
        .insertInto("user_permission_overrides")
        .values({
          user_id: Number(userRow.id),
          permission: "staff.user_class",
          effect: "grant",
          expires_at: null,
          actor_id: null,
          created_at: Date.now(),
        })
        .execute();

      await db.schema.alterTable("users").dropColumn("seed_points").execute();
      await runMigrations(db, "sqlite");
      const users = await db.selectFrom("users").select(["id", "username"]).orderBy("id").execute();
      expect(users.map((row) => row.username)).toEqual(["alice_2", "alice", "user3"]);

      const notifications = await db
        .selectFrom("notifications")
        .select("id")
        .where("title", "=", "用户名已调整")
        .execute();
      expect(notifications.length).toBe(2);

      const staff = await db
        .selectFrom("classes")
        .select("permissions_json")
        .where("id", "=", staffClass.id)
        .executeTakeFirstOrThrow();
      const staffPermissions = JSON.parse(staff.permissions_json) as string[];
      expect(staffPermissions).toContain("staff.user_edit.email");
      expect(staffPermissions).not.toContain("staff.user_edit");
      expect(staffPermissions).not.toContain("staff.user_edit.class");
      expect(staffPermissions).not.toContain("staff.user_edit.status");

      const overrides = await db
        .selectFrom("user_permission_overrides")
        .select("permission")
        .where("user_id", "=", userRow.id)
        .execute();
      expect(overrides.map((row) => row.permission)).toEqual(["staff.user_edit.class"]);
    } finally {
      await db.destroy();
    }
  });
});

describe("username API", () => {
  let ctx: TestContext;
  let admin: LoggedIn;
  let staff: LoggedIn;

  async function grant(userId: number, permissions: string[]): Promise<void> {
    for (const permission of permissions) {
      await ctx.db
        .insertInto("user_permission_overrides")
        .values({
          user_id: userId,
          permission,
          effect: "grant",
          expires_at: null,
          actor_id: null,
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(["user_id", "permission"]).doNothing())
        .execute();
    }
  }

  it("normalizes signup/login and enforces field permissions", async () => {
    ctx = await createTestContext();
    try {
      admin = await login(ctx.app, "lightbringer");
      const csrf = await ctx.app.inject({ method: "GET", url: `${API_PREFIX}/auth/csrf` });
      const cookie = String(csrf.headers["set-cookie"] ?? "");
      const token = /kp_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";

      const signup = await ctx.app.inject({
        method: "POST",
        url: `${API_PREFIX}/auth/signup`,
        headers: { cookie: `kp_csrf=${token}`, "x-csrf-token": token },
        payload: {
          username: "NewUser",
          email: "newuser@example.com",
          password: TEST_PASSWORD,
          password_confirm: TEST_PASSWORD,
          rules_accepted: true,
        },
      });
      expect(signup.statusCode).toBe(201);
      const created = await ctx.db
        .selectFrom("users")
        .select(["id", "username"])
        .where("email", "=", "newuser@example.com")
        .executeTakeFirstOrThrow();
      expect(created.username).toBe("newuser");

      const loginUpper = await login(ctx.app, "NEWUSER", TEST_PASSWORD);
      expect(loginUpper.username).toBe("newuser");

      const axue = await ctx.db
        .selectFrom("users")
        .select("id")
        .where("username", "=", "axue")
        .executeTakeFirstOrThrow();
      const root = await ctx.db
        .selectFrom("users")
        .select("id")
        .where("username", "=", "root")
        .executeTakeFirstOrThrow();
      await grant(Number(axue.id), [
        "staff.available",
        "staff.users",
        "staff.user_edit.email",
      ]);
      staff = await login(ctx.app, "axue", TEST_PASSWORD);

      const emailUpdate = await ctx.app.inject({
        method: "PUT",
        url: `${API_PREFIX}/staff/users/${String(root.id)}`,
        headers: { cookie: staff.cookieHeader, "x-csrf-token": staff.csrfToken },
        payload: { email: "root2@example.com" },
      });
      expect(emailUpdate.statusCode).toBe(200);

      const passwordDenied = await ctx.app.inject({
        method: "PUT",
        url: `${API_PREFIX}/staff/users/${String(root.id)}`,
        headers: { cookie: staff.cookieHeader, "x-csrf-token": staff.csrfToken },
        payload: { password: "denied-pass-123" },
      });
      expect(passwordDenied.statusCode).toBe(403);

      const parentDenied = await ctx.app.inject({
        method: "PUT",
        url: `${API_PREFIX}/staff/users/${String(root.id)}`,
        headers: { cookie: staff.cookieHeader, "x-csrf-token": staff.csrfToken },
        payload: { username: "root2" },
      });
      expect(parentDenied.statusCode).toBe(403);

      await grant(Number(axue.id), ["staff.user_edit.username"]);
      staff = await login(ctx.app, "axue", TEST_PASSWORD);
      const renameAdmin = await ctx.app.inject({
        method: "PUT",
        url: `${API_PREFIX}/staff/users/${String(root.id)}`,
        headers: { cookie: staff.cookieHeader, "x-csrf-token": staff.csrfToken },
        payload: { username: "admin" },
      });
      expect(renameAdmin.statusCode).toBe(200);
      const renamed = await ctx.db
        .selectFrom("users")
        .select("username")
        .where("id", "=", root.id)
        .executeTakeFirstOrThrow();
      expect(renamed.username).toBe("admin");
      void admin;
    } finally {
      await ctx.app.close();
      await ctx.db.destroy();
    }
  });
});
