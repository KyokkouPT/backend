import type { Db } from "../db/db.js";

/** 站内通知：始终写库；邮件在社区纵切按偏好异步发送。 */
export async function createNotification(
  db: Db,
  input: {
    userId: number;
    kind: string;
    title: string;
    body: string;
    linkUrl?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("notifications")
    .values({
      user_id: input.userId,
      kind: input.kind,
      title: input.title.slice(0, 190),
      body: input.body,
      link_url: input.linkUrl ?? null,
      read_at: null,
      created_at: Date.now(),
    })
    .execute();
}

export async function unreadNotificationCount(db: Db, userId: number): Promise<number> {
  const row = await db
    .selectFrom("notifications")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}
