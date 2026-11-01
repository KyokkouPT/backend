import type { Db } from "../db/db.js";
import { computePermissions, type ClassRow } from "./classes.js";
import type { FormulaContext, FormulaTorrent, FormulaUserMetrics } from "./bonus-formula.js";

export type BonusUserContext = FormulaContext & {
  id: number;
  username: string;
  status: string;
  frozenUntil: number | null;
};

type UserBatchRow = {
  id: number;
  username: string;
  status: string;
  class_id: number | null;
  uploaded: number;
  downloaded: number;
  bonus: number;
  created_at: number;
  bonus_frozen_until: number | null;
};

type OverrideBatchRow = {
  user_id: number;
  permission: string;
  effect: "grant" | "deny";
  expires_at: number | null;
};

function userMetrics(user: UserBatchRow, isDonor: boolean, now: number): FormulaUserMetrics {
  return {
    seeders: 0,
    totalGb: 0,
    totalBytes: 0,
    avgSizeGb: 0,
    uploaded: Number(user.uploaded),
    downloaded: Number(user.downloaded),
    ratio: Number(user.downloaded) > 0 ? Number(user.uploaded) / Number(user.downloaded) : 0,
    ageDays: Math.max(0, Math.floor((now - Number(user.created_at)) / 86_400_000)),
    bonus: Number(user.bonus),
    isDonor,
    hour: new Date(now).getHours(),
    dayOfWeek: new Date(now).getDay(),
    userId: Number(user.id),
  };
}

/**
 * 批量构建公式上下文：用户、做种种子、捐赠身份。
 * 调用方传入一批用户 id，避免在用户循环里逐条查库。
 */
export async function loadBonusContexts(
  db: Db,
  userIds: number[],
  now = Date.now(),
): Promise<Map<number, BonusUserContext>> {
  const output = new Map<number, BonusUserContext>();
  if (userIds.length === 0) return output;

  const [users, torrentRows, overrideRows, classRows] = await Promise.all([
    db
      .selectFrom("users")
      .select([
        "id",
        "username",
        "status",
        "class_id",
        "uploaded",
        "downloaded",
        "bonus",
        "created_at",
        "bonus_frozen_until",
      ])
      .where("id", "in", userIds)
      .where("status", "=", "active")
      .execute(),
    db
      .selectFrom("snatches as sn")
      .innerJoin("torrents as t", "t.id", "sn.torrent_id")
      .select([
        "sn.user_id as user_id",
        "t.id as id",
        "t.size as size",
        "t.created_at as created_at",
        "t.seeders as seeders",
        "t.zero_bonus as zero_bonus",
        "t.promo as promo",
      ])
      .where("sn.user_id", "in", userIds)
      .where("sn.status", "=", "seeding")
      .where("t.status", "=", "approved")
      .where("t.deleted_at", "is", null)
      .execute(),
    db
      .selectFrom("user_permission_overrides")
      .select(["user_id", "permission", "effect", "expires_at"])
      .where("user_id", "in", userIds)
      .execute(),
    db.selectFrom("classes").selectAll().execute(),
  ]);

  const classById = new Map<number, ClassRow>(classRows.map((row) => [Number(row.id), row]));
  const overridesByUser = new Map<number, OverrideBatchRow[]>();
  for (const row of overrideRows) {
    const list = overridesByUser.get(Number(row.user_id)) ?? [];
    list.push(row as OverrideBatchRow);
    overridesByUser.set(Number(row.user_id), list);
  }

  const torrentsByUser = new Map<number, FormulaTorrent[]>();
  for (const row of torrentRows) {
    const created = Number(row.created_at);
    const ageDays = Math.max(0, (now - created) / 86_400_000);
    const list = torrentsByUser.get(Number(row.user_id)) ?? [];
    list.push({
      id: Number(row.id),
      sizeBytes: Number(row.size),
      ageWeeks: ageDays / 7,
      ageDays,
      seeders: Number(row.seeders),
      zeroBonus: Number(row.zero_bonus) === 1,
      promo: row.promo,
    });
    torrentsByUser.set(Number(row.user_id), list);
  }

  for (const user of users) {
    const id = Number(user.id);
    const classRow = user.class_id === null ? null : (classById.get(Number(user.class_id)) ?? null);
    const overrides = (overridesByUser.get(id) ?? []).map((row) => ({
      ...row,
      expires_at: row.expires_at === null ? null : Number(row.expires_at),
    }));
    const permissions = computePermissions(classRow, overrides, now);
    const userTorrents = torrentsByUser.get(id) ?? [];
    const totalBytes = userTorrents.reduce((sum, item) => sum + item.sizeBytes, 0);
    const metrics = userMetrics(user, permissions.includes("user.donor"), now);
    metrics.seeders = userTorrents.length;
    metrics.totalBytes = totalBytes;
    metrics.totalGb = totalBytes / 1024 ** 3;
    metrics.avgSizeGb = userTorrents.length > 0 ? metrics.totalGb / userTorrents.length : 0;
    output.set(id, {
      id,
      username: user.username,
      status: user.status,
      frozenUntil:
        user.bonus_frozen_until === null ? null : Number(user.bonus_frozen_until),
      user: metrics,
      torrents: userTorrents,
    });
  }

  return output;
}
