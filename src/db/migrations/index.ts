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
import { migration011 } from "./011_bonus_formula.js";
import { migration012 } from "./012_scheduler_leases.js";
import { migration013 } from "./013_tracker_peers.js";
import { migration014 } from "./014_username_rules.js";
import { migration015 } from "./015_username_permission_cleanup.js";
import { migration016 } from "./016_bonus_shop.js";
import { migration017 } from "./017_invite_email.js";
import { migration018 } from "./018_invite_username.js";
import { migration019 } from "./019_invite_code_case.js";
import { migration020 } from "./020_tracker_sessions.js";
import { migration021 } from "./021_staff_message_jobs.js";
import { migration022 } from "./022_assessments.js";
import { migration023 } from "./023_assessment_auto.js";
import { migration024 } from "./024_seed_points.js";
import { migration025 } from "./025_staff_operations.js";
import { migration026 } from "./026_leechwarn_recovery.js";
import { migration027 } from "./027_class_reward_once.js";
import { migration028 } from "./028_class_recovery_bands.js";

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
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
];

export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
