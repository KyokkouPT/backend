import { z } from "zod";

/**
 * 站点设置 schema 与默认值（docs/18 §8）。
 *
 * 只存在于后端：设置由 Staff 接口写入 site_settings.key，前端通过
 * /api/v1/site 与 /api/v1/bootstrap 读取，不直接复制这个包。
 */

export const siteSettings = z.object({
  name: z.string().min(1).max(64),
  tagline: z.string().max(160),
  locale: z.string().min(2).max(16),
});

export const registrationSettings = z.object({
  open: z.boolean(),
  invite_registration_enabled: z.boolean(),
  closed_message: z.string().max(500),
});

export const trackerSettings = z.object({
  announce_interval: z.number().int().min(60),
  min_interval: z.number().int().min(30),
  peer_ttl: z.number().int().min(60),
  max_peers: z.number().int().min(1),
  allow_ipv6: z.boolean(),
});

export const economySettings = z.object({
  bonus_enabled: z.boolean(),
  exchange_enabled: z.boolean(),
  request_min_bounty: z.number().int().min(0),
  request_max_bounty: z.number().int().min(0),
});

export const reviewSettings = z.object({
  auto_approve_trusted: z.boolean(),
  trusted_min_approved: z.number().int().min(0),
  pending_alert_hours: z.number().int().min(1),
});

export const classesSettings = z.object({
  recalc_enabled: z.boolean(),
  recalc_cron: z.string().min(5).max(64),
});

export const SETTING_KEYS = ["site", "registration", "tracker", "economy", "review", "classes"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const settingsSchema = z.object({
  site: siteSettings,
  registration: registrationSettings,
  tracker: trackerSettings,
  economy: economySettings,
  review: reviewSettings,
  classes: classesSettings,
});

export type SiteSettings = z.infer<typeof siteSettings>;
export type RegistrationSettings = z.infer<typeof registrationSettings>;
export type TrackerSettings = z.infer<typeof trackerSettings>;
export type EconomySettings = z.infer<typeof economySettings>;
export type ReviewSettings = z.infer<typeof reviewSettings>;
export type ClassesSettings = z.infer<typeof classesSettings>;
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  site: {
    name: "KyokkouPT",
    tagline: "通用、可配置、可自部署的私有种子站引擎",
    locale: "zh-CN",
  },
  registration: {
    open: true,
    invite_registration_enabled: true,
    closed_message: "本站当前关闭注册，请等待开放或联系管理员获取邀请码。",
  },
  tracker: {
    announce_interval: 1800,
    min_interval: 900,
    peer_ttl: 3600,
    max_peers: 200,
    allow_ipv6: true,
  },
  economy: {
    bonus_enabled: true,
    exchange_enabled: true,
    request_min_bounty: 500,
    request_max_bounty: 50000,
  },
  review: {
    auto_approve_trusted: true,
    trusted_min_approved: 5,
    pending_alert_hours: 24,
  },
  classes: {
    recalc_enabled: true,
    recalc_cron: "*/15 * * * *",
  },
};
