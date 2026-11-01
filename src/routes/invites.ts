import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { sql, type SqlBool } from "kysely";
import { API_PREFIX, inviteCreateBody, inviteItem, invitePreview, invitesResponse } from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { HttpProblem, badRequest, conflict } from "../lib/problem.js";
import { loadSettings } from "../lib/settings.js";
import { parseOrThrow } from "../lib/validate.js";
import { validateUsername } from "../lib/username.js";

const INVITE_TTL_MS = 30 * 86_400_000;

function newInviteCode(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

function isCodeCollision(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (candidate.code === "SQLITE_CONSTRAINT_UNIQUE" || candidate.code === "23505") return true;
  if (candidate.errno === 1062) return true;
  return /unique constraint failed: invites\.code|duplicate entry .*invites\.code/i.test(
    typeof candidate.message === "string" ? candidate.message : "",
  );
}

export function inviteRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/me/invites`, async (request) => {
      const auth = requireAuth(request);
      const rows = await db
        .selectFrom("invites as i")
        .leftJoin("users as u", "u.id", "i.invited_user_id")
        .select([
          "i.code as code",
          "i.status as status",
          "i.created_at as created_at",
          "i.expires_at as expires_at",
          "i.used_at as used_at",
          "i.email as email",
          "i.username as username",
          "u.username as invited_user",
        ])
        .where("i.inviter_id", "=", Number(auth.user.id))
        .orderBy("i.created_at", "desc")
        .limit(50)
        .execute();

      const used = rows.filter((row) => row.status === "used").length;
      const userRow = await db
        .selectFrom("users")
        .select("invite_balance")
        .where("id", "=", Number(auth.user.id))
        .executeTakeFirstOrThrow();

      return invitesResponse.parse({
        items: rows.map((row) => ({
          code: row.code,
          status: row.status,
          created_at: Number(row.created_at),
          expires_at: Number(row.expires_at),
          used_at: row.used_at === null ? null : Number(row.used_at),
          invited_user: row.invited_user,
          email: row.email,
          username: row.username,
        })),
        quota_used: used,
        quota_total: Number(userRow.invite_balance),
      });
    });

    app.post(`${API_PREFIX}/me/invites`, async (request, reply) => {
      const auth = requireAuth(request);
      if (!auth.permissions.includes("invite.create")) {
        throw new HttpProblem(403, "forbidden", "当前等级不能生成邀请");
      }
      assertCsrf(request, auth.session);
      const body = parseOrThrow(inviteCreateBody, request.body ?? {});
      const settings = await loadSettings(db);
      const email = body.email?.trim().toLowerCase() || null;
      const usernameChecked = body.username
        ? validateUsername(body.username, { allowAdmin: false })
        : null;
      if (usernameChecked && !usernameChecked.ok) {
        throw badRequest(usernameChecked.code, usernameChecked.message);
      }
      const username = usernameChecked?.ok ? usernameChecked.username : null;
      if (settings.registration.invite_require_email && !email) {
        throw badRequest("invite_email_required", "当前生成邀请码必须填写预注册邮箱");
      }
      if (settings.registration.invite_require_username && !username) {
        throw badRequest("invite_username_required", "当前生成邀请码必须填写预注册用户名");
      }

      const now = Date.now();
      let code: string | null = null;
      for (let attempt = 0; attempt < 8 && code === null; attempt += 1) {
        const candidate = newInviteCode();
        try {
          await db.transaction().execute(async (trx) => {
            const updated = await trx
              .updateTable("users")
              .set((eb) => ({ invite_balance: eb("invite_balance", "-", 1) }))
              .where("id", "=", Number(auth.user.id))
              .where("invite_balance", ">", 0)
              .execute();
            if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
              throw conflict("invite_quota_exhausted", "邀请余额不足");
            }
            await trx
              .insertInto("invites")
              .values({
                code: candidate,
                inviter_id: Number(auth.user.id),
                invited_user_id: null,
                status: "unused",
                note: null,
                expires_at: now + INVITE_TTL_MS,
                created_at: now,
                used_at: null,
                email,
                username,
              })
              .execute();
          });
          code = candidate;
        } catch (error) {
          if (!isCodeCollision(error)) throw error;
        }
      }
      if (code === null) {
        throw new HttpProblem(500, "invite_code_generation_failed", "邀请码生成失败，请重试");
      }

      return reply.status(201).send(
        inviteItem.parse({
          code,
          status: "unused",
          created_at: now,
          expires_at: now + INVITE_TTL_MS,
          used_at: null,
          invited_user: null,
          email,
          username,
        }),
      );
    });

    app.get(`${API_PREFIX}/invites/:code`, async (request) => {
      const code = (request.params as { code: string }).code.toUpperCase();
      const row = await db
        .selectFrom("invites as i")
        .leftJoin("users as u", "u.id", "i.inviter_id")
        .select([
          "i.status as status",
          "i.expires_at as expires_at",
          "i.email as email",
          "i.username as username",
          "u.username as inviter",
        ])
        .where(sql<SqlBool>`upper(${sql.ref("i.code")}) = ${code}`)
        .executeTakeFirst();

      if (!row) {
        return invitePreview.parse({
          valid: false,
          reason: "邀请码不存在",
          inviter: null,
          expires_at: null,
          email: null,
          username: null,
        });
      }

      const expired = Number(row.expires_at) <= Date.now();
      const valid = row.status === "unused" && !expired;
      return invitePreview.parse({
        valid,
        reason: row.status !== "unused" ? "邀请码已被使用" : expired ? "邀请码已过期" : null,
        inviter: row.inviter ?? null,
        expires_at: Number(row.expires_at),
        email: valid ? row.email : null,
        username: valid ? row.username : null,
      });
    });
  };
}
