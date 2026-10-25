import type { Db } from "../db/db.js";
import { getMailer } from "./mailer.js";

/**
 * 站内通知：始终写库；若配置了 SMTP 且用户偏好开启，异步发送邮件。
 * 邮件失败只影响旁路，不阻塞调用方。
 */
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

  await maybeSendEmail(db, input);
}

/** kind → user_preferences 列名；未列出的 kind 不发邮件。 */
const PREFERENCE_BY_KIND: Record<string, string> = {
  review: "email_review",
  hnr: "email_hnr",
  invite: "email_invite",
  social: "email_social",
  weekly: "email_weekly",
};

/** 没有 user_preferences 行时的默认值，与 /auth/signup 的默认一致。 */
const DEFAULT_ON = new Set(["email_review", "email_hnr", "email_invite"]);

async function maybeSendEmail(
  db: Db,
  input: { userId: number; kind: string; title: string; body: string; linkUrl?: string | null },
): Promise<void> {
  const mailer = getMailer();
  if (!mailer) return;

  const preferenceKey = PREFERENCE_BY_KIND[input.kind];
  if (!preferenceKey) return;

  const user = await db
    .selectFrom("users")
    .select(["email", "status"])
    .where("id", "=", input.userId)
    .executeTakeFirst();
  if (!user || user.status !== "active") return;

  const preferences = await db
    .selectFrom("user_preferences")
    .selectAll()
    .where("user_id", "=", input.userId)
    .executeTakeFirst();

  const enabled = preferences
    ? Number((preferences as Record<string, unknown>)[preferenceKey] ?? 0) === 1
    : DEFAULT_ON.has(preferenceKey);
  if (!enabled) return;

  const lines = [input.body, ""];
  if (input.linkUrl) lines.push(`链接：${input.linkUrl}`, "");
  lines.push("—— 此邮件由站点通知系统自动发送，可在账号设置中关闭。");

  void mailer.send({
    to: user.email,
    subject: `[站点通知] ${input.title}`,
    text: lines.join("\n"),
  });
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
