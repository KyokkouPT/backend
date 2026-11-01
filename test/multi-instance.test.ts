import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { acquireJobLease, releaseJobLease } from "../src/lib/scheduler.js";

describe("multi-instance job leases", () => {
  it("allows only one owner until the lease is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyokkou-lease-"));
    const url = join(dir, "test.db");
    const first = createDb({ driver: "sqlite", url });
    const second = createDb({ driver: "sqlite", url });
    try {
      await runMigrations(first, "sqlite");
      expect(await acquireJobLease(first, "scheduler:bonus", "instance-a", 60_000)).toBe(true);
      expect(await acquireJobLease(second, "scheduler:bonus", "instance-b", 60_000)).toBe(false);
      await releaseJobLease(first, "scheduler:bonus", "instance-a");
      expect(await acquireJobLease(second, "scheduler:bonus", "instance-b", 60_000)).toBe(true);
    } finally {
      await first.destroy();
      await second.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
