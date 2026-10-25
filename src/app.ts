import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { healthRoute } from "./routes/health.js";

/**
 * 组装 Fastify 应用。测试用 buildApp() + app.inject()，
 * 生产由 server.ts 负责 listen 与优雅关闭。
 */
export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, ...options });

  app.register(healthRoute);

  return app;
}
