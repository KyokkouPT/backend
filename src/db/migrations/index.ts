import type { Migration } from "./types.js";
import { migration001 } from "./001_init.js";
import { migration002 } from "./002_notifications.js";
import { migration003 } from "./003_tracker.js";
import { migration004 } from "./004_economy.js";
import { migration005 } from "./005_community.js";

/** 有序迁移清单；新增迁移只追加，不改历史版本。 */
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
];

export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
