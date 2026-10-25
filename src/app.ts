import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/db.js";
import { createAuthHook } from "./auth/session.js";
import { HttpProblem } from "./lib/problem.js";
import { healthRoute } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { siteRoutes } from "./routes/site.js";
import { meRoutes } from "./routes/me.js";
import { torrentRoutes } from "./routes/torrents.js";
import { staffRoutes } from "./routes/staff.js";
import { notificationRoutes } from "./routes/notifications.js";

export type AppDeps = {
  db: Db;
  config: AppConfig;
};

function problemBody(status: number, code: string, title: string, requestId: string) {
  return {
    type: `https://kyokkou.local/problems/${code}`,
    title,
    status,
    code,
    request_id: requestId,
  };
}

/**
 * 组装 Fastify 应用。测试用 buildApp() + app.inject()，
 * 生产由 server.ts 负责 listen 与优雅关闭。
 */
export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, ...options });

  app.register(cookie);
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // onRequest：解析 kp_session → request.auth（未登录为 null）。
  app.addHook("onRequest", createAuthHook(deps.db));

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof HttpProblem) {
      return reply
        .status(error.status)
        .type("application/problem+json")
        .send(error.toBody(requestId));
    }

    const err = error as { statusCode?: unknown; code?: unknown; message?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const code = typeof err.code === "string" ? err.code : "bad_request";
      return reply
        .status(statusCode)
        .type("application/problem+json")
        .send(problemBody(statusCode, code, err.message ?? "请求错误", requestId));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply
      .status(500)
      .type("application/problem+json")
      .send(problemBody(500, "internal_error", "服务器内部错误", requestId));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .type("application/problem+json")
      .send(problemBody(404, "not_found", "接口不存在", request.id)),
  );

  app.register(healthRoute);
  app.register(authRoutes(deps));
  app.register(siteRoutes(deps));
  app.register(meRoutes(deps));
  app.register(torrentRoutes(deps));
  app.register(staffRoutes(deps));
  app.register(notificationRoutes({ db: deps.db }));

  return app;
}
