import { z } from "zod";

/**
 * 环境变量校验。覆盖启动、数据库、会话、seed 与可选 SMTP。
 * 生产环境必须显式提供 SESSION_SECRET 与 SEED_PASSWORD，否则拒绝启动。
 */
const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-change-me-32";
const DEV_SEED_PASSWORD = "kyokkou-dev";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(31001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_DRIVER: z.enum(["sqlite", "mysql", "mariadb", "postgres"]).default("sqlite"),
  DATABASE_URL: z.string().min(1).default("file:./data/kyokkou.db"),

  /** 公开前端地址，用于 announce/download/RSS 链接；不要用 BASE_URL。 */
  KYOKKOU_BASE_URL: z.string().url().default("http://localhost:31002"),

  /** 可选：Tracker 的独立公开地址；未设置时与 KYOKKOU_BASE_URL 相同。 */
  TRACKER_PUBLIC_URL: z.string().url().optional(),

  SESSION_SECRET: z.string().min(32).default(DEV_SESSION_SECRET),
  SEED_PASSWORD: z.string().min(8).max(200).default(DEV_SEED_PASSWORD),

  /** 生产默认给 Cookie 加 Secure；本地/内网 HTTP 测试可显式关闭。 */
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),

  /** 部署在 Nginx 后面时信任 X-Forwarded-*；生产默认开启。 */
  TRUST_PROXY: z.enum(["true", "false"]).optional(),

  /** 标准 SMTP；全部可选，配置 SMTP_HOST + SMTP_FROM 后启用邮件。 */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
  SMTP_SECURE: z.enum(["true", "false", "1", "0"]).optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().email().optional(),
});

export type DatabaseDriver = z.infer<typeof envSchema>["DATABASE_DRIVER"];

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

export type AppConfig = {
  nodeEnv: z.infer<typeof envSchema>["NODE_ENV"];
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databaseDriver: DatabaseDriver;
  databaseUrl: string;
  baseUrl: string;
  trackerBaseUrl: string;
  sessionSecret: string;
  seedPassword: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  smtp: SmtpConfig | null;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** 解析环境变量；失败时抛出可读的 ConfigError，不静默使用错误配置。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ConfigError(`Invalid environment: ${JSON.stringify(fields)}`);
  }

  const data = parsed.data;

  if (data.NODE_ENV === "production") {
    if (data.SESSION_SECRET === DEV_SESSION_SECRET) {
      throw new ConfigError("SESSION_SECRET must be set to a unique value in production");
    }
    if (data.SEED_PASSWORD === DEV_SEED_PASSWORD) {
      throw new ConfigError("SEED_PASSWORD must be changed in production");
    }
  }

  let smtp: SmtpConfig | null = null;
  if (data.SMTP_HOST) {
    if (!data.SMTP_FROM) {
      throw new ConfigError("SMTP_FROM must be set when SMTP_HOST is configured");
    }
    if ((data.SMTP_USER && !data.SMTP_PASS) || (!data.SMTP_USER && data.SMTP_PASS)) {
      throw new ConfigError("SMTP_USER and SMTP_PASS must be configured together");
    }

    const secure = data.SMTP_SECURE === "true" || data.SMTP_SECURE === "1";
    smtp = {
      host: data.SMTP_HOST,
      port: data.SMTP_PORT ?? (secure ? 465 : 587),
      secure,
      user: data.SMTP_USER ?? null,
      pass: data.SMTP_PASS ?? null,
      from: data.SMTP_FROM,
    };
  }

  return {
    nodeEnv: data.NODE_ENV,
    host: data.HOST,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseDriver: data.DATABASE_DRIVER,
    databaseUrl: data.DATABASE_URL,
    baseUrl: data.KYOKKOU_BASE_URL.replace(/\/+$/, ""),
    trackerBaseUrl: (data.TRACKER_PUBLIC_URL ?? data.KYOKKOU_BASE_URL).replace(/\/+$/, ""),
    sessionSecret: data.SESSION_SECRET,
    seedPassword: data.SEED_PASSWORD,
    cookieSecure:
      data.COOKIE_SECURE === undefined
        ? data.NODE_ENV === "production"
        : data.COOKIE_SECURE === "true",
    trustProxy:
      data.TRUST_PROXY === undefined
        ? data.NODE_ENV === "production"
        : data.TRUST_PROXY === "true",
    smtp,
  };
}
