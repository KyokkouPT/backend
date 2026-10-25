import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";

type DbLike = Kysely<Database> | Transaction<Database>;

/** 分区策略优先，其次全局（section_id 为 null）。 */
export async function loadHnrPolicy(db: DbLike, sectionId: number | null) {
  if (sectionId !== null) {
    const bySection = await db
      .selectFrom("hnr_policies")
      .selectAll()
      .where("section_id", "=", sectionId)
      .where("enabled", "=", 1)
      .executeTakeFirst();
    if (bySection) return bySection;
  }

  return db
    .selectFrom("hnr_policies")
    .selectAll()
    .where("section_id", "is", null)
    .where("enabled", "=", 1)
    .executeTakeFirst();
}

/**
 * announce 时评估 H&R：
 * - 下载量达到 min_download 且尚无义务 → 创建 inspecting；
 * - 已有 inspecting → 累加做种时长，达到要求 / 超期时结算。
 */
export async function evaluateHnr(
  db: DbLike,
  input: {
    userId: number;
    torrentId: number;
    sectionId: number | null;
    downloaded: number;
    seededSecondsDelta: number;
    isSeeding: boolean;
  },
): Promise<void> {
  const policy = await loadHnrPolicy(db, input.sectionId);
  if (!policy) return;

  const now = Date.now();
  const existing = await db
    .selectFrom("hnr_obligations")
    .selectAll()
    .where("user_id", "=", input.userId)
    .where("torrent_id", "=", input.torrentId)
    .executeTakeFirst();

  if (existing) {
    if (existing.status !== "inspecting") return;

    const seeded = Number(existing.seeded_seconds) + (input.isSeeding ? input.seededSecondsDelta : 0);
    const reached = seeded >= Number(existing.required_seconds);
    const expired = !reached && Number(existing.deadline_at) <= now;
    const status = reached ? "reached" : expired ? "unreached" : "inspecting";

    if (seeded !== Number(existing.seeded_seconds) || status !== existing.status) {
      await db
        .updateTable("hnr_obligations")
        .set({
          seeded_seconds: seeded,
          status,
          resolved_at: status === "inspecting" ? null : now,
        })
        .where("id", "=", existing.id)
        .execute();
    }
    return;
  }

  if (input.downloaded >= Number(policy.min_download)) {
    await db
      .insertInto("hnr_obligations")
      .values({
        user_id: input.userId,
        torrent_id: input.torrentId,
        policy_id: Number(policy.id),
        required_seconds: Number(policy.seed_seconds),
        seeded_seconds: 0,
        deadline_at: now + Number(policy.deadline_days) * 86_400_000,
        status: "inspecting",
        resolved_at: null,
        created_at: now,
      })
      .execute();
  }
}

/** 定时结算：达到做种要求 → reached；超期未达到 → unreached。 */
export async function settleHnr(db: Kysely<Database>): Promise<number> {
  const now = Date.now();
  const rows = await db
    .selectFrom("hnr_obligations")
    .selectAll()
    .where("status", "=", "inspecting")
    .execute();

  let changed = 0;
  for (const row of rows) {
    const reached = Number(row.seeded_seconds) >= Number(row.required_seconds);
    const expired = !reached && Number(row.deadline_at) <= now;
    if (!reached && !expired) continue;

    await db
      .updateTable("hnr_obligations")
      .set({ status: reached ? "reached" : "unreached", resolved_at: now })
      .where("id", "=", row.id)
      .execute();
    changed += 1;
  }

  return changed;
}
