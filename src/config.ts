import { z } from "zod";

/**
 * 环境变量校验。Phase 0 只覆盖启动必需项；
 * 数据库 / session / seed / SMTP 变量在 Phase 1 追加。
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(31001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppConfig = {
  nodeEnv: z.infer<typeof envSchema>["NODE_ENV"];
  host: string;
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
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

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
