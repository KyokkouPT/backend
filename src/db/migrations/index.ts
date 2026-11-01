import type { Migration } from "./types.js";
import { migration001 } from "./001_init.js";
import { migration002 } from "./002_notifications.js";
import { migration003 } from "./003_tracker.js";
import { migration004 } from "./004_economy.js";
import { migration005 } from "./005_community.js";
import { migration006 } from "./006_twofa.js";
import { migration007 } from "./007_moderation.js";
import { migration008 } from "./008_classes.js";
import { migration009 } from "./009_class_simulator.js";
import { migration010 } from "./010_raw_traffic.js";

/** 有序迁移清单；新增迁移只追加，不改历史版本。 */
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
];

export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
