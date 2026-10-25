import type { AppealItem } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";

/** 读取申诉及其消息（用户端与 Staff 端共用）。 */
export async function loadAppeals(
  db: Db,
  options: { userId?: number; status?: string; limit?: number } = {},
): Promise<AppealItem[]> {
  let query = db
    .selectFrom("appeals as a")
    .innerJoin("users as u", "u.id", "a.user_id")
    .select([
      "a.id as id",
      "a.kind as kind",
      "a.target_id as target_id",
      "a.reason as reason",
      "a.status as status",
      "a.created_at as created_at",
      "a.resolved_at as resolved_at",
      "a.resolution_note as resolution_note",
      "u.username as username",
    ]);

  if (options.userId !== undefined) query = query.where("a.user_id", "=", options.userId);
  if (options.status) query = query.where("a.status", "=", options.status);

  const rows = await query.orderBy("a.created_at", "desc").limit(options.limit ?? 50).execute();
  const ids = rows.map((row) => Number(row.id));

  const messageRows =
    ids.length > 0
      ? await db
          .selectFrom("appeal_messages as m")
          .leftJoin("users as u", "u.id", "m.author_id")
          .select([
            "m.appeal_id as appeal_id",
            "m.body as body",
            "m.created_at as created_at",
            "u.username as author",
          ])
          .where("m.appeal_id", "in", ids)
          .orderBy("m.created_at", "asc")
          .execute()
      : [];

  const messagesByAppeal = new Map<number, AppealItem["messages"]>();
  for (const message of messageRows) {
    const key = Number(message.appeal_id);
    const list = messagesByAppeal.get(key) ?? [];
    list.push({
      author: message.author,
      body: message.body,
      created_at: Number(message.created_at),
    });
    messagesByAppeal.set(key, list);
  }

  return rows.map((row) => ({
    id: Number(row.id),
    user: { name: row.username },
    kind: row.kind,
    target_id: row.target_id,
    reason: row.reason,
    status: row.status,
    created_at: Number(row.created_at),
    resolved_at: row.resolved_at === null ? null : Number(row.resolved_at),
    resolution_note: row.resolution_note,
    messages: messagesByAppeal.get(Number(row.id)) ?? [],
  }));
}
