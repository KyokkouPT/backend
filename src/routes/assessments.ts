import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  API_PREFIX,
  PERMISSIONS,
  assessmentAssignmentItem,
  myAssessmentsResponse,
  staffAssessmentAssignBody,
  staffAssessmentAssignResponse,
  staffAssessmentBody,
  staffAssessmentItem,
  staffAssessmentListResponse,
  staffAssessmentParticipantsResponse,
  staffAssessmentPreviewResponse,
} from "@kyokkou/contracts";
import type { Db } from "../db/db.js";
import { assertCsrf, requireAuth } from "../auth/csrf.js";
import {
  createAssessmentRecord,
  createAssignment,
  getAssessment,
  getMyAssignment,
  listAssessmentOffers,
  listMyAssignments,
  listParticipants,
  parseAssessment,
  refreshAssignmentProgress,
  resolveAssessmentUsers,
  settleAssignment,
  toStaffAssessment,
  updateAssessmentRecord,
} from "../lib/assessments.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/problem.js";
import { parseOrThrow } from "../lib/validate.js";

function requireStaff(request: FastifyRequest) {
  const auth = requireAuth(request);
  if (!auth.permissions.includes(PERMISSIONS.staffClasses)) {
    throw forbidden("forbidden", "没有考核/任务管理权限");
  }
  return auth;
}

export function assessmentRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    const { db } = deps;

    app.get(`${API_PREFIX}/me/assessments`, async (request) => {
      const auth = requireAuth(request);
      const userId = Number(auth.user.id);
      const [items, available] = await Promise.all([
        listMyAssignments(db, userId),
        listAssessmentOffers(db, userId),
      ]);
      return myAssessmentsResponse.parse({ items, available });
    });

    app.get(`${API_PREFIX}/me/assessments/:id`, async (request) => {
      const auth = requireAuth(request);
      const id = Number((request.params as { id: string }).id);
      const assignment = await getMyAssignment(db, Number(auth.user.id), id);
      if (!assignment) throw notFound("assessment_assignment_not_found", "考核/任务不存在");
      return assessmentAssignmentItem.parse(assignment);
    });

    app.post(`${API_PREFIX}/me/assessments/:id/claim`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const row = await getAssessment(db, id);
      if (!row || row.status !== "active" || row.type !== "task") {
        throw badRequest("assessment_unavailable", "该任务当前不可领取");
      }
      const assignment = await createAssignment(db, parseAssessment(row), Number(auth.user.id), null, "claim");
      const item = await getMyAssignment(db, Number(auth.user.id), Number(assignment.id));
      if (!item) throw notFound("assessment_assignment_not_found", "考核/任务不存在");
      return assessmentAssignmentItem.parse(item);
    });

    app.post(`${API_PREFIX}/me/assessments/:id/abandon`, async (request) => {
      const auth = requireAuth(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const row = await db
        .selectFrom("assessment_assignments")
        .select(["id", "user_id", "status"])
        .where("id", "=", id)
        .where("user_id", "=", Number(auth.user.id))
        .executeTakeFirst();
      if (!row) throw notFound("assessment_assignment_not_found", "考核/任务不存在");
      if (!["assigned", "claimed", "in_progress"].includes(row.status)) {
        throw conflict("assessment_already_finished", "考核/任务已结束");
      }
      await db
        .updateTable("assessment_assignments")
        .set({ status: "cancelled", result_reason: "用户放弃", completed_at: Date.now() })
        .where("id", "=", id)
        .execute();
      return { ok: true };
    });

    app.get(`${API_PREFIX}/staff/assessments`, async (request) => {
      requireStaff(request);
      const rows = await db
        .selectFrom("assessments")
        .selectAll()
        .orderBy("created_at", "desc")
        .execute();
      return staffAssessmentListResponse.parse({
        items: await Promise.all(rows.map((row) => toStaffAssessment(db, row))),
      });
    });

    app.post(`${API_PREFIX}/staff/assessments/preview`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffAssessmentBody, request.body ?? {});
      const users = await resolveAssessmentUsers(db, body.filters ?? {});
      return staffAssessmentPreviewResponse.parse({ matched: users.length });
    });

    app.post(`${API_PREFIX}/staff/assessments`, async (request, reply) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const body = parseOrThrow(staffAssessmentBody, request.body ?? {});
      const item = await createAssessmentRecord(db, body, Number(auth.user.id));
      return reply.status(201).send(item);
    });

    app.get(`${API_PREFIX}/staff/assessments/:id`, async (request) => {
      requireStaff(request);
      const id = Number((request.params as { id: string }).id);
      const row = await getAssessment(db, id);
      if (!row) throw notFound("assessment_not_found", "考核/任务不存在");
      return toStaffAssessment(db, row);
    });

    app.put(`${API_PREFIX}/staff/assessments/:id`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(staffAssessmentBody, request.body ?? {});
      const item = await updateAssessmentRecord(db, id, body);
      if (!item) throw notFound("assessment_not_found", "考核/任务不存在");
      return item;
    });

    app.post(`${API_PREFIX}/staff/assessments/:id/preview`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const row = await getAssessment(db, id);
      if (!row) throw notFound("assessment_not_found", "考核/任务不存在");
      const users = await resolveAssessmentUsers(db, parseAssessment(row).filters);
      return staffAssessmentPreviewResponse.parse({ matched: users.length });
    });

    app.post(`${API_PREFIX}/staff/assessments/:id/assign`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const body = parseOrThrow(staffAssessmentAssignBody, request.body ?? {});
      const row = await getAssessment(db, id);
      if (!row) throw notFound("assessment_not_found", "考核/任务不存在");
      const assessment = parseAssessment(row);
      let assigned = 0;
      let skipped = 0;
      for (const userId of [...new Set(body.user_ids)]) {
        try {
          await createAssignment(db, assessment, userId, Number(auth.user.id));
          assigned += 1;
        } catch {
          skipped += 1;
        }
      }
      return staffAssessmentAssignResponse.parse({ assigned, skipped });
    });

    app.get(`${API_PREFIX}/staff/assessments/:id/participants`, async (request) => {
      requireStaff(request);
      const id = Number((request.params as { id: string }).id);
      const row = await getAssessment(db, id);
      if (!row) throw notFound("assessment_not_found", "考核/任务不存在");
      return staffAssessmentParticipantsResponse.parse({ items: await listParticipants(db, id) });
    });

    app.post(`${API_PREFIX}/staff/assessments/:id/checkout`, async (request) => {
      const auth = requireStaff(request);
      assertCsrf(request, auth.session);
      const id = Number((request.params as { id: string }).id);
      const row = await getAssessment(db, id);
      if (!row) throw notFound("assessment_not_found", "考核/任务不存在");
      const assignments = await db
        .selectFrom("assessment_assignments")
        .select("id")
        .where("assessment_id", "=", id)
        .where("status", "in", ["assigned", "claimed", "in_progress"])
        .execute();
      let settled = 0;
      for (const assignment of assignments) {
        await refreshAssignmentProgress(db, Number(assignment.id));
        if (await settleAssignment(db, Number(assignment.id), true)) settled += 1;
      }
      return { settled };
    });
  };
}
