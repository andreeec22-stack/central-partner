import type { PerformanceRating, Prisma, SurveyStatus } from '@prisma/client';
import { cached, cacheKeys, invalidate } from '../../lib/cache';
import { forbidden } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { localDay } from '../../lib/week';
import type { AuthUser } from '../../types';
import { mean, overallScoreOf, reviewPeriodOf } from './scoring';
import { teamReviewFilter, teamSurveyFilter } from './surveys.access';

// Per-department summary of a quarter's evaluations for managers. Cached for
// 5 minutes and invalidated whenever a survey changes status or a review is
// published (see invalidateSurveyDashboards), so it is never stale after an action.

const DASHBOARD_TTL_SECONDS = 5 * 60;
const RATINGS: PerformanceRating[] = ['EXCEEDS_EXPECTATIONS', 'MEETS_EXPECTATIONS', 'DEVELOPING', 'NEEDS_IMPROVEMENT', 'NOT_YET_RATED'];

// ADMINs share one entry; a JEFE_AREA's excludes their own evaluations, so it is per person.
const scopeKey = (user: Pick<AuthUser, 'role' | 'id'>) => (user.role === 'ADMIN' ? 'all' : `jefe:${user.id}`);

export function currentPeriod(timeZone: string, now = new Date()) {
  return reviewPeriodOf(localDay(now, timeZone));
}

export async function invalidateSurveyDashboards(workspaceId: string, period: string, departmentId: string | null) {
  const jefes = departmentId
    ? await prisma.user.findMany({ where: { workspaceId, departmentId, role: 'JEFE_AREA' }, select: { id: true, role: true } })
    : [];
  await invalidate(
    cacheKeys.surveyDashboard(workspaceId, period, 'all'),
    ...jefes.map((j) => cacheKeys.surveyDashboard(workspaceId, period, scopeKey(j))),
  );
}

type Counts = Record<SurveyStatus, number> & { overdue: number; total: number };
const emptyCounts = (): Counts => ({ SCHEDULED: 0, ACTIVE: 0, COMPLETED: 0, CANCELLED: 0, overdue: 0, total: 0 });

export async function surveyDashboard(user: AuthUser, period = currentPeriod(user.workspaceTimezone)) {
  if (user.role !== 'ADMIN' && (user.role !== 'JEFE_AREA' || !user.departmentId)) throw forbidden();
  return cached(cacheKeys.surveyDashboard(user.workspaceId, period, scopeKey(user)), DASHBOARD_TTL_SECONDS, () => build(user, period));
}

async function build(user: AuthUser, period: string) {
  const now = new Date();
  // A JEFE_AREA sees their team only: not themselves, not a peer head (CR-01).
  const own = user.role === 'ADMIN' ? {} : teamSurveyFilter(user);
  const surveyWhere: Prisma.SurveyWhereInput = { workspaceId: user.workspaceId, reviewPeriod: period, ...own };
  const reviewWhere: Prisma.PerformanceReviewWhereInput = {
    workspaceId: user.workspaceId,
    reviewPeriod: period,
    ...(user.role === 'ADMIN' ? {} : teamReviewFilter(user)),
  };

  const [departments, surveys, reviews] = await Promise.all([
    prisma.department.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, ...(user.role === 'ADMIN' ? {} : { id: user.departmentId! }) },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.survey.findMany({
      where: surveyWhere,
      select: { departmentId: true, status: true, endDate: true, performanceScore: true, productivityIndex: true, dualScore: true },
    }),
    prisma.performanceReview.findMany({ where: reviewWhere, select: { departmentId: true, performanceRating: true, publishedAt: true } }),
  ]);

  const summarize = (deptSurveys: typeof surveys, deptReviews: typeof reviews) => {
    const counts = emptyCounts();
    for (const s of deptSurveys) {
      counts[s.status]++;
      counts.total++;
      if ((s.status === 'SCHEDULED' || s.status === 'ACTIVE') && s.endDate < now) counts.overdue++;
    }
    const completed = deptSurveys.filter((s) => s.status === 'COMPLETED');
    const ratings = Object.fromEntries(RATINGS.map((r) => [r, deptReviews.filter((v) => v.performanceRating === r).length])) as Record<PerformanceRating, number>;
    return {
      surveys: counts,
      completionRate: counts.total - counts.CANCELLED > 0 ? Math.round((counts.COMPLETED / (counts.total - counts.CANCELLED)) * 1000) / 10 : null,
      avgPerformanceScore: mean(completed.map((s) => s.performanceScore)),
      avgProductivityIndex: mean(completed.map((s) => s.productivityIndex)),
      avgDualScore: mean(completed.map((s) => overallScoreOf(s.dualScore))),
      reviews: { total: deptReviews.length, published: deptReviews.filter((r) => r.publishedAt).length, ratings },
    };
  };

  return {
    period,
    generatedAt: now.toISOString(),
    totals: summarize(surveys, reviews),
    departments: departments.map((d) => ({
      department: d,
      ...summarize(
        surveys.filter((s) => s.departmentId === d.id),
        reviews.filter((r) => r.departmentId === d.id),
      ),
    })),
  };
}
