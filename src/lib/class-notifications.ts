import type { Db } from "../db/db.js";
import { classNotificationTemplates, type ClassNotificationTemplates } from "@kyokkou/contracts";
import { createNotification } from "./notifications.js";

export const DEFAULT_CLASS_TEMPLATES: ClassNotificationTemplates = {
  promote: "你的等级已升级为「{new_class}」，感谢你的贡献。",
  demote: "你的等级已调整为「{new_class}」，原因：{reason}。",
  demote_warning: "你的等级将在 {date} 后调整为「{new_class}」，原因：{reason}。",
};

const KEY = "class_notifications";

export async function loadClassTemplates(db: Db): Promise<ClassNotificationTemplates> {
  const row = await db
    .selectFrom("site_settings")
    .select("value_json")
    .where("key", "=", KEY)
    .executeTakeFirst();

  if (!row) return DEFAULT_CLASS_TEMPLATES;
  try {
    const parsed = classNotificationTemplates.partial().parse(JSON.parse(row.value_json));
    return {
      promote: parsed.promote ?? DEFAULT_CLASS_TEMPLATES.promote,
      demote: parsed.demote ?? DEFAULT_CLASS_TEMPLATES.demote,
      demote_warning: parsed.demote_warning ?? DEFAULT_CLASS_TEMPLATES.demote_warning,
    };
  } catch {
    return DEFAULT_CLASS_TEMPLATES;
  }
}

export async function saveClassTemplates(db: Db, templates: ClassNotificationTemplates): Promise<void> {
  const now = Date.now();
  const value = JSON.stringify(templates);
  const updated = await db
    .updateTable("site_settings")
    .set({ value_json: value, updated_at: now })
    .where("key", "=", KEY)
    .execute();
  if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
    await db.insertInto("site_settings").values({ key: KEY, value_json: value, updated_at: now }).execute();
  }
}

export function renderClassTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => vars[key] ?? match);
}

export async function notifyClassChange(
  db: Db,
  input: {
    userId: number;
    kind: "promote" | "demote" | "demote_warning";
    oldName: string;
    newName: string;
    reason: string;
    date?: string;
  },
): Promise<void> {
  const templates = await loadClassTemplates(db);
  const template = templates[input.kind];
  const body = renderClassTemplate(template, {
    username: "",
    old_class: input.oldName,
    new_class: input.newName,
    reason: input.reason,
    date: input.date ?? "",
    site_name: "",
  });

  await createNotification(db, {
    userId: input.userId,
    kind: "account",
    title: input.kind === "promote" ? "等级提升" : input.kind === "demote" ? "等级调整" : "等级调整预告",
    body,
    linkUrl: "/me",
  });
}
