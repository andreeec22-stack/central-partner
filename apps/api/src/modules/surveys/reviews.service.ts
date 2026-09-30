import type { PerformanceReview, Prisma } from '@prisma/client';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors';
import { toSkipTake } from '../../lib/pagination';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { dayToDate } from '../../lib/week';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { aggregateReview } from './scoring';
import { canManageEvaluationsOf, checkReviewAccess, reviewVisibilityFilter, surveyVisibilityFilter } from './surveys.access';
import { invalidateSurveyDashboards } from './surveys.dashboard';
import type { UpdateReviewInput } from './surveys.schemas';

// PerformanceReview = one person's quarter, the AGGREGATE of their completed
// surveys (scoring.ts explains Survey.dualScore → overallDualScore). It is
// rebuilt from the Survey rows every time one of them changes status, so it
// can't drift from them; the managers' texts (comments, strengths, goals) and
// the publication are the only hand-written parts.

/**
 * Recomputes the review of `userId` for `period` from their surveys.
 * No completed survey yet → no review (returns the existing one untouched, or null).
 */
export async function upsertPerformanceReview(workspaceId: string, userId: string, period: string, db: Tx = prisma) {
  const surveys = await db.survey.findMany({
    where: { workspaceId, evaluatedUserId: userId, reviewPeriod: period, status: { not: 'CANCELLED' } },
    select: { type: true, status: true, productivityIndex: true, productivityData: true, performanceScore: true, dualScore: true, completedAt: true },
  });
  const completed = surveys.filter((s) => s.status === 'COMPLETED');
  const existing = await db.performanceReview.findUnique({ where: { userId_reviewPeriod: { userId, reviewPeriod: period } } });
  if (completed.length === 0) {
    return existing ? db.performanceReview.update({ where: { id: existing.id }, data: { surveysInitiated: surveys.length } }) : null;
  }

  const subject = await db.user.findUnique({ where: { id: userId }, select: { departmentId: true } });
  const latest = [...completed].sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0]!;
  const scores = { ...aggregateReview(completed), surveysInitiated: surveys.length };
  const performanceData = (latest.productivityData ?? undefined) as Prisma.InputJsonValue | undefined;

  return db.performanceReview.upsert({
    where: { userId_reviewPeriod: { userId, reviewPeriod: period } },
    create: { workspaceId, userId, reviewPeriod: period, departmentId: subject?.departmentId ?? null, performanceData, ...scores },
    update: { performanceData, ...scores },
  });
}

const include = {
  user: { select: { id: true, displayName: true, email: true, role: true } },
  department: { select: { id: true, name: true, color: true } },
  publishedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.PerformanceReviewInclude;
type ReviewRow = PerformanceReview & Prisma.PerformanceReviewGetPayload<{ include: typeof include }>;

function present(user: AuthUser, r: ReviewRow) {
  const subject = { id: r.userId, departmentId: r.departmentId, role: r.user.role };
  const canManage = canManageEvaluationsOf(user, subject);
  return {
    id: r.id,
    reviewPeriod: r.reviewPeriod,
    user: r.user,
    department: r.department,
    surveysCompleted: r.surveysCompleted,
    surveysInitiated: r.surveysInitiated,
    selfAssessmentScore: r.selfAssessmentScore,
    managerReviewScore: r.managerReviewScore,
    overallPerformanceScore: r.overallPerformanceScore,
    overallProductivityIndex: r.overallProductivityIndex,
    overallDualScore: r.overallDualScore,
    performanceRating: r.performanceRating,
    riskLevel: r.riskLevel,
    performanceData: r.performanceData,
    managerComments: r.managerComments,
    employeeComments: r.employeeComments,
    strengths: r.strengths,
    areasForImprovement: r.areasForImprovement,
    developmentGoals: r.developmentGoals,
    nextReviewDate: r.nextReviewDate ? r.nextReviewDate.toISOString().slice(0, 10) : null,
    publishedAt: r.publishedAt,
    publishedBy: r.publishedBy,
    updatedAt: r.updatedAt,
    permissions: {
      canEdit: canManage,
      canPublish: canManage && !r.publishedAt,
      canComment: r.userId === user.id && !!r.publishedAt,
    },
  };
}

async function findVisible(user: AuthUser, id: string): Promise<ReviewRow> {
  const r = await prisma.performanceReview.findFirst({ where: { id, workspaceId: user.workspaceId }, include });
  if (!r) throw notFound('Review');
  if (!checkReviewAccess(user, r)) throw forbidden('No tienes acceso a esta evaluación');
  return r;
}

export async function listReviews(user: AuthUser, q: { period?: string; departmentId?: string; page: number; limit: number }) {
  if (user.role === 'VIEWER') throw forbidden();
  const where: Prisma.PerformanceReviewWhereInput = {
    AND: [reviewVisibilityFilter(user), { ...(q.period ? { reviewPeriod: q.period } : {}), ...(q.departmentId ? { departmentId: q.departmentId } : {}) }],
  };
  const [rows, total] = await Promise.all([
    prisma.performanceReview.findMany({ where, include, orderBy: [{ reviewPeriod: 'desc' }, { overallDualScore: { sort: 'asc', nulls: 'last' } }], ...toSkipTake(q) }),
    prisma.performanceReview.count({ where }),
  ]);
  return { data: rows.map((r) => present(user, r)), pagination: { page: q.page, limit: q.limit, total } };
}

export async function getReview(user: AuthUser, id: string) {
  const r = await findVisible(user, id);
  const published = r.publishedAt ? [r.reviewPeriod] : [];
  const surveys = await prisma.survey.findMany({
    where: { AND: [surveyVisibilityFilter(user, r.userId === user.id ? published : []), { evaluatedUserId: r.userId, reviewPeriod: r.reviewPeriod }] },
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      completedAt: true,
      performanceScore: true,
      productivityIndex: true,
      dualScore: true,
      evaluator: { select: { id: true, displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return { review: present(user, r), surveys };
}

const MANAGER_FIELDS = ['managerComments', 'strengths', 'areasForImprovement', 'developmentGoals', 'nextReviewDate'] as const;

export async function updateReview(user: AuthUser, id: string, input: UpdateReviewInput, ctx: ClientContext) {
  const r = await findVisible(user, id);
  const wantsManagerFields = MANAGER_FIELDS.some((f) => input[f] !== undefined);
  if (wantsManagerFields && !canManageEvaluationsOf(user, { id: r.userId, departmentId: r.departmentId, role: r.user.role })) {
    throw forbidden('Solo el director o el jefe del área editan la evaluación');
  }
  if (input.employeeComments !== undefined) {
    if (r.userId !== user.id) throw forbidden('Solo la persona evaluada escribe sus comentarios');
    if (!r.publishedAt) throw new AppError(409, 'REVIEW_NOT_PUBLISHED', 'Podrás comentar cuando tu evaluación se publique');
  }

  const data: Prisma.PerformanceReviewUpdateInput = {
    ...(input.managerComments !== undefined ? { managerComments: input.managerComments } : {}),
    ...(input.employeeComments !== undefined ? { employeeComments: input.employeeComments } : {}),
    ...(input.strengths ? { strengths: input.strengths } : {}),
    ...(input.areasForImprovement ? { areasForImprovement: input.areasForImprovement } : {}),
    ...(input.developmentGoals ? { developmentGoals: input.developmentGoals } : {}),
    ...(input.nextReviewDate !== undefined ? { nextReviewDate: input.nextReviewDate ? dayToDate(input.nextReviewDate) : null } : {}),
  };
  const updated = await prisma.performanceReview.update({ where: { id }, data, include });
  const after = Object.fromEntries(Object.keys(data).map((k) => [k, (updated as unknown as Record<string, unknown>)[k]]));
  const changes = diffFields(r as unknown as Record<string, unknown>, after);
  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.PERFORMANCE_REVIEW_UPDATED,
    entityType: 'PerformanceReview',
    entityId: id,
    changes,
    metadata: { subjectId: r.userId, period: r.reviewPeriod },
    ipAddress: ctx.ipAddress,
  });
  return { review: present(user, updated) };
}

export async function publishReview(user: AuthUser, id: string, ctx: ClientContext) {
  const r = await findVisible(user, id);
  if (!canManageEvaluationsOf(user, { id: r.userId, departmentId: r.departmentId, role: r.user.role })) throw forbidden('Solo el director o el jefe del área publican');
  if (r.publishedAt) throw new AppError(409, 'REVIEW_ALREADY_PUBLISHED', 'La evaluación ya está publicada');
  if (r.surveysCompleted === 0) throw validationError('No hay encuestas completadas que publicar');

  const updated = await prisma.performanceReview.update({ where: { id }, data: { publishedAt: new Date(), publishedById: user.id }, include });
  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.PERFORMANCE_REVIEW_PUBLISHED,
    entityType: 'PerformanceReview',
    entityId: id,
    metadata: { subjectId: r.userId, period: r.reviewPeriod, overallDualScore: r.overallDualScore, rating: r.performanceRating },
    ipAddress: ctx.ipAddress,
  });
  await invalidateSurveyDashboards(user.workspaceId, r.reviewPeriod, r.departmentId);
  emitTo([rooms.user(r.userId), rooms.admins(user.workspaceId)], 'review:changed', { reviewId: id, userId: r.userId, period: r.reviewPeriod });
  return { review: present(user, updated) };
}
