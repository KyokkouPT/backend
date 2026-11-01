import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  API_PREFIX,
  PERMISSIONS,
  reviewActionResponse,
  reviewQueueResponse,
  reviewReasonsResponse,
  type ReviewReason,
} from "@kyokkou/contracts";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import { permissionsFor } from "../auth/permissions.js";
import { HttpProblem, badRequest, conflict, notFound } from "../lib/problem.js";
import { createNotification } from "../lib/notifications.js";
import { loadReviewQueue } from "../lib/torrent-query.js";

const REVIEW_REASONS: ReviewReason[] = [
  {
    key: "naming",
    label: "命名不规范",
    detail: "标题未按分区命名规范填写，请按规范重命名后重新提交。",
  },
  {
    key: "metadata",
    label: "元数据不完整",
    detail: "缺少必填字段，或字段值与种子内容不符。",
  },
  {
    key: "duplicate",
    label: "重复发布",
    detail: "站内已有相同或更高规格的版本。",
  },
  {
    key: "quality",
    label: "质量不达标",
    detail: "码率、音轨或字幕不符合分区发布要求。",
  },
  { key: "other", label: "其他", detail: "请补充具体理由。" },
];

function requirePermission(request: FastifyRequest, permission: string) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(permission)) {
    throw new HttpProblem(403, "forbidden", "没有权限");
  }
  return auth;
}

export function staffRoutes(deps: { db: Db; config: AppConfig }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/staff/review`, async (request) => {
      requirePermission(request, PERMISSIONS.staffReview);
      const items = await loadReviewQueue(db);
      return reviewQueueResponse.parse({ items });
    });

    app.get(`${API_PREFIX}/staff/review/reasons`, async (request) => {
      requirePermission(request, PERMISSIONS.staffReview);
      return reviewReasonsResponse.parse({ reasons: REVIEW_REASONS });
    });

    app.post(`${API_PREFIX}/staff/review/:id/:action`, async (request) => {
      const auth = requirePermission(request, PERMISSIONS.staffReview);
      assertCsrf(request, auth.session);

      const { id: rawId, action } = request.params as { id: string; action: string };
      if (action !== "approve" && action !== "reject" && action !== "return") {
        throw notFound("invalid_action", "不支持的操作");
      }

      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) throw notFound("torrent_not_found", "种子不存在");

      const body = (request.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (action !== "approve" && reason.length < 2) {
        throw badRequest("reason_required", "请填写审核理由", [
          { path: "reason", message: "理由必填，至少 2 个字" },
        ]);
      }

      const torrent = await db
        .selectFrom("torrents")
        .select(["id", "name", "uploader_id", "status"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!torrent) throw notFound("torrent_not_found", "种子不存在");
      if (torrent.status !== "pending") throw conflict("not_pending", "该种子不在待审状态");

      const now = Date.now();
      const nextStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";

      await db
        .updateTable("torrents")
        .set(action === "approve" ? { status: nextStatus, approved_at: now } : { status: nextStatus })
        .where("id", "=", id)
        .execute();

      await db
        .insertInto("audit_logs")
        .values({
          actor_id: Number(auth.user.id),
          action: `torrent.${action}`,
          target_type: "torrent",
          target_id: String(id),
          detail_json: JSON.stringify({ reason: reason.length > 0 ? reason : null }),
          ip: request.ip,
          created_at: now,
        })
        .execute();

      const title =
        action === "approve"
          ? "种子审核通过"
          : action === "reject"
            ? "种子被驳回"
            : "种子需要修改";
      const detail =
        action === "approve"
          ? `你发布的种子「${torrent.name}」已通过审核并公开。`
          : `你发布的种子「${torrent.name}」${action === "reject" ? "被驳回" : "需要修改"}：${reason}`;

      await createNotification(db, {
        userId: Number(torrent.uploader_id),
        kind: "review",
        title,
        body: detail,
        linkUrl: action === "approve" ? `/t/${String(id)}` : null,
      });

      return reviewActionResponse.parse({ ok: true, status: nextStatus });
    });
  };
}
