import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@kyokkou/config";
import type { Db } from "../db/db.js";

/**
 * 读取 site_settings 并合并默认值。
 * 存库的每个 value_json 是完整的一类设置（site/registration/...），
 * 所以按键浅合并即可；schema 校验失败说明数据损坏，直接抛错而不是静默兜底。
 */
export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.selectFrom("site_settings").select(["key", "value_json"]).execute();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    try {
      merged[row.key] = JSON.parse(row.value_json);
    } catch {
      // 坏 JSON 保留默认值，避免整站不可用；下一次 Staff 保存会覆盖。
    }
  }

  return settingsSchema.parse(merged);
}
