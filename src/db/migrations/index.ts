import type { Migration } from "./types.js";
import { migration001 } from "./001_init.js";
import { migration002 } from "./002_notifications.js";

/** 有序迁移清单；新增迁移只追加，不改历史版本。 */
export const migrations: Migration[] = [migration001, migration002];

export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
