import type { FastifyInstance } from "fastify";
import { API_PREFIX, healthResponse } from "@kyokkou/contracts";
import { APP_VERSION } from "../version.js";

export const SERVICE_NAME = "kyokkoupt-backend";

/** GET /api/v1/health —— 负载均衡/部署探活使用，不返回任何敏感信息。 */
export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/health`, async () =>
    healthResponse.parse({
      ok: true,
      service: SERVICE_NAME,
      version: APP_VERSION,
    }),
  );
}
