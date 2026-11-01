import type { FastifyPluginAsync } from "fastify";
import {
  API_PREFIX,
  appealMessageBody,
  appealsResponse,
  createAppealBody,
  publicAppealBody,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { verifyPassword } from "../auth/password.js";
import { loadAppeals } from "../lib/appeals.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";
import { normalizeUsername } from "../lib/username.js";

export function appealRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/me/appeals`, async (request) => {
      const auth = requireAuth(request);
      return appealsResponse.parse({
        items: await loadAppeals(db, { userId: Number(auth.user.id) }),
      });
    });

    app.post(`${API_PREFIX}/me/appeals`, async (request, reply) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(createAppealBody, request.body ?? {});

      await db
        .insertInto("appeals")
        .values({
          user_id: Number(auth.user.id),
          kind: body.kind,
          target_id: null,
          reason: body.reason.trim(),
          status: "open",
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
          created_at: Date.now(),
        })
        .execute();

      return reply.status(201).send({ ok: true });
    });

    app.post(`${API_PREFIX}/me/appeals/:id/messages`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(appealMessageBody, request.body ?? {});

      const appeal = await db.selectFrom("appeals").selectAll().where("id", "=", id).executeTakeFirst();
      if (!appeal) throw notFound("appeal_not_found", "申诉不存在");
      if (Number(appeal.user_id) !== Number(auth.user.id)) {
        throw new HttpProblem(403, "forbidden", "没有权限");
      }
      if (appeal.status !== "open") throw conflict("appeal_not_open", "申诉已处理");

      await db
        .insertInto("appeal_messages")
        .values({
          appeal_id: id,
          author_id: Number(auth.user.id),
          body: body.body.trim(),
          created_at: Date.now(),
        })
        .execute();

      return { ok: true };
    });

    app.post(`${API_PREFIX}/me/appeals/:id/withdraw`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);

      const appeal = await db.selectFrom("appeals").selectAll().where("id", "=", id).executeTakeFirst();
      if (!appeal) throw notFound("appeal_not_found", "申诉不存在");
      if (Number(appeal.user_id) !== Number(auth.user.id)) {
        throw new HttpProblem(403, "forbidden", "没有权限");
      }
      if (appeal.status !== "open") throw conflict("appeal_not_open", "申诉已处理");

      await db
        .updateTable("appeals")
        .set({ status: "withdrawn", resolved_at: Date.now() })
        .where("id", "=", id)
        .execute();

      return { ok: true };
    });

    // 免登录封禁申诉：只能针对非 active 账号，密码校验后提交。
    app.post(`${API_PREFIX}/appeals/public`, async (request, reply) => {
      assertCsrf(request, null);
      const body = parseOrThrow(publicAppealBody, request.body ?? {});

      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("username", "=", normalizeUsername(body.username))
        .where("email", "=", body.email.trim().toLowerCase())
        .executeTakeFirst();

      if (!user || !(await verifyPassword(user.password_hash, body.password))) {
        throw new HttpProblem(401, "invalid_credentials", "用户名、邮箱或密码不正确");
      }
      if (user.status === "active") throw badRequest("appeal_not_needed", "账号状态正常，无需申诉");

      await db
        .insertInto("appeals")
        .values({
          user_id: Number(user.id),
          kind: "ban",
          target_id: user.status,
          reason: body.reason.trim(),
          status: "open",
          resolved_by: null,
          resolved_at: null,
          resolution_note: null,
          created_at: Date.now(),
        })
        .execute();

      return reply.status(201).send({ ok: true });
    });
  };
}
