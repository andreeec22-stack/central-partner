import type { PerformanceRating, Prisma, Role } from '@prisma/client';
import { cached, invalidate } from '../../lib/cache';
import { forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { dateToDay, localDay } from '../../lib/week';
import type { AuthUser } from '../../types';
import { okrStatus, type OkrStatus } from '../okrs/okr-progress';
import { mean, reviewPeriodOf } from '../surveys/scoring';

// Performance scorecard (Phase 2, RF-01): the quarter's KPIs for the company
// (ADMIN) or for one area's team (its JEFE_AREA; an ADMIN may pick any area).
//
//   performance    mean of the people's review overallPerformanceScore (surveys)
//   productivity   mean of overallProductivityIndex (Module 1)
//   collaboration  always null — Module 1 has no source for it (ADR-002)
//   okrs           share of the quarter's OKRs completed, plus their mean progress
//
// Each person counts once (no per-area weights), so the company figure is the
// headcount-weighted mean of the areas. Trend = the same KPIs for the previous
// three quarters, computed live from the reviews and OKRs (no snapshot table:
// a recalculated past review shows up in the trend).

export const DEFAULT_PERFORMANCE_TARGET = 80;
const TTL_SECONDS = 5 * 60;
const MANAGER_ROLES: Role[] = ['ADMIN', 'JEFE_AREA'];

type TargetStatus = 'ON_TARGET' | 'AT_RISK' | 'BELOW' | 'NO_DATA';
export function targetStatus(value: number | null, target: number): TargetStatus {
  if (value === null) return 'NO_DATA';
  if (value >= target) return 'ON_TARGET';
  if (value >= target - 10) return 'AT_RISK';
  return 'BELOW';
}

export function previousPeriods(period: string, count: number): string[] {
  const out = [period];
  let year = Number(period.slice(0, 4));
  let q = Number(period.slice(-1));
  while (out.length < count) {
    q--;
    if (q === 0) {
      q = 4;
      year--;
    }
    out.push(`${year}-Q${q}`);
  }
  return out.reverse();
}

const scopeKey = (scope: Scope) => (scope.kind === 'company' ? 'company' : `dept:${scope.departmentId}:${scope.teamOnly ? 'team' : 'all'}`);
const cacheKey = (workspaceId: string, period: string, scope: Scope) => `scorecard:${workspaceId}:${period}:${scopeKey(scope)}`;

// Called after reviews or OKRs change. Company-level views and the area's views.
export async function invalidateScorecard(workspaceId: string, period: string, departmentId: string | null) {
  const keys = [cacheKey(workspaceId, period, { kind: 'company' })];
  if (departmentId) {
    keys.push(
      cacheKey(workspaceId, period, { kind: 'team', departmentId, teamOnly: true }),
      cacheKey(workspaceId, period, { kind: 'team', departmentId, teamOnly: false }),
    );
  }
  await invalidate(...keys);
}

type Scope = { kind: 'company' } | { kind: 'team'; departmentId: string; teamOnly: boolean };

export async function scorecard(user: AuthUser, q: { period?: string; departmentId?: string }) {
  const period = q.period ?? reviewPeriodOf(localDay(new Date(), user.workspaceTimezone));
  let scope: Scope;
  if (user.role === 'ADMIN') scope = q.departmentId ? { kind: 'team', departmentId: q.departmentId, teamOnly: false } : { kind: 'company' };
  else if (user.role === 'JEFE_AREA' && user.departmentId) {
    if (q.departmentId && q.departmentId !== user.departmentId) throw forbidden('Solo ves el tablero de tu área');
    // A head sees their team: not peer heads (same rule as evaluations, CR-01).
    scope = { kind: 'team', departmentId: user.departmentId, teamOnly: true };
  } else throw forbidden('El tablero es para el director y los jefes de área');

  return cached(cacheKey(user.workspaceId, period, scope), TTL_SECONDS, () => build(user.workspaceId, user.workspaceTimezone, period, scope));
}

async function build(workspaceId: string, timeZone: string, period: string, scope: Scope) {
  const today = localDay(new Date(), timeZone);
  const departments = await prisma.department.findMany({
    where: { workspaceId, deletedAt: null, ...(scope.kind === 'team' ? { id: scope.departmentId } : {}) },
    select: { id: true, name: true, color: true, performanceTarget: true, headId: true },
    orderBy: { name: 'asc' },
  });
  if (scope.kind === 'team' && !departments.length) throw notFound('Department');

  const peopleWhere: Prisma.UserWhereInput = {
    workspaceId,
    deletedAt: null,
    departmentId: scope.kind === 'team' ? scope.departmentId : { not: null },
    role: scope.kind === 'team' && scope.teamOnly ? { notIn: MANAGER_ROLES } : { not: 'ADMIN' },
  };
  const people = await prisma.user.findMany({ where: peopleWhere, select: { id: true, displayName: true, role: true, departmentId: true }, orderBy: { displayName: 'asc' } });
  const peopleIds = people.map((p) => p.id);

  const periods = previousPeriods(period, 4);
  const okrWhere: Prisma.OkrWhereInput =
    scope.kind === 'company'
      ? { workspaceId }
      : { workspaceId, OR: [{ level: 'AREA', departmentId: scope.departmentId }, { level: 'PERSON', ownerUserId: { in: peopleIds } }] };

  const [reviews, okrs] = await Promise.all([
    prisma.performanceReview.findMany({
      where: { workspaceId, userId: { in: peopleIds }, reviewPeriod: { in: periods } },
      select: {
        id: true,
        userId: true,
        reviewPeriod: true,
        overallPerformanceScore: true,
        overallProductivityIndex: true,
        overallDualScore: true,
        performanceRating: true,
        publishedAt: true,
        lastRecalculatedAt: true,
      },
    }),
    prisma.okr.findMany({
      where: { ...okrWhere, period: { in: periods } },
      select: { id: true, title: true, level: true, period: true, progress: true, deadline: true, departmentId: true, ownerUserId: true },
    }),
  ]);

  const statusOf = (o: (typeof okrs)[number]): OkrStatus => okrStatus(o.progress, o.period, o.deadline ? dateToDay(o.deadline) : null, today);

  const kpisFor = (p: string, personIds?: Set<string>, okrFilter?: (o: (typeof okrs)[number]) => boolean) => {
    const rs = reviews.filter((r) => r.reviewPeriod === p && (!personIds || personIds.has(r.userId)));
    const os = okrs.filter((o) => o.period === p && (!okrFilter || okrFilter(o)));
    return {
      performance: mean(rs.map((r) => r.overallPerformanceScore)),
      productivity: mean(rs.map((r) => r.overallProductivityIndex)),
      collaboration: null as number | null,
      okrCompletion: os.length ? Math.round((os.filter((o) => o.progress >= 100).length / os.length) * 1000) / 10 : null,
      okrProgress: mean(os.map((o) => o.progress)),
      reviewsCount: rs.length,
      okrsCount: os.length,
    };
  };

  const trend = periods.map((p) => ({ period: p, ...kpisFor(p) }));
  const current = trend[trend.length - 1]!;
  const previous = trend[trend.length - 2]!;
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) * 10) / 10);
  const kpis = {
    performance: { value: current.performance, delta: delta(current.performance, previous.performance) },
    okrCompletion: { value: current.okrCompletion, delta: delta(current.okrCompletion, previous.okrCompletion), progress: current.okrProgress, count: current.okrsCount },
    collaboration: { value: null, delta: null, reason: 'NO_SOURCE' as const },
    productivity: { value: current.productivity, delta: delta(current.productivity, previous.productivity) },
    coverage: { people: people.length, withReview: current.reviewsCount },
  };

  const areas = departments.map((d) => {
    const ids = new Set(people.filter((p) => p.departmentId === d.id).map((p) => p.id));
    const k = kpisFor(period, ids, (o) => o.departmentId === d.id && o.level !== 'COMPANY');
    const target = d.performanceTarget ?? DEFAULT_PERFORMANCE_TARGET;
    return {
      department: { id: d.id, name: d.name, color: d.color },
      people: ids.size,
      withReview: k.reviewsCount,
      performance: k.performance,
      productivity: k.productivity,
      okrProgress: k.okrProgress,
      target,
      status: targetStatus(k.performance, target),
    };
  });

  const peopleRows =
    scope.kind === 'team'
      ? people.map((p) => {
          const r = reviews.find((x) => x.userId === p.id && x.reviewPeriod === period);
          return {
            user: { id: p.id, displayName: p.displayName, role: p.role },
            review: r
              ? {
                  id: r.id,
                  performance: r.overallPerformanceScore,
                  productivity: r.overallProductivityIndex,
                  dual: r.overallDualScore,
                  rating: r.performanceRating as PerformanceRating,
                  published: !!r.publishedAt,
                  recalculated: !!r.lastRecalculatedAt,
                }
              : null,
            okrProgress: mean(okrs.filter((o) => o.period === period && o.ownerUserId === p.id).map((o) => o.progress)),
          };
        })
      : undefined;

  const alerts = [
    ...areas
      .filter((a) => a.status === 'BELOW' || a.status === 'AT_RISK')
      .map((a) => ({
        kind: 'AREA_BELOW_TARGET' as const,
        severity: a.status === 'BELOW' ? ('high' as const) : ('medium' as const),
        department: a.department,
        value: a.performance,
        target: a.target,
      })),
    ...okrs
      .filter((o) => o.period === period && (scope.kind === 'team' || o.level !== 'PERSON'))
      .map((o) => ({ o, status: statusOf(o) }))
      .filter(({ status }) => status === 'OFF_TRACK' || status === 'AT_RISK')
      .map(({ o, status }) => ({
        kind: 'OKR_OFF_TRACK' as const,
        severity: status === 'OFF_TRACK' ? ('high' as const) : ('medium' as const),
        okr: { id: o.id, title: o.title, level: o.level, progress: o.progress, status },
      })),
  ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));

  // A head compares their team with the company (aggregates only).
  const company = scope.kind === 'team' ? await companyAggregate(workspaceId, period) : undefined;

  return {
    period,
    scope: scope.kind,
    department: scope.kind === 'team' ? departments[0] && { id: departments[0].id, name: departments[0].name, target: departments[0].performanceTarget ?? DEFAULT_PERFORMANCE_TARGET } : null,
    generatedAt: new Date().toISOString(),
    kpis,
    trend,
    areas: scope.kind === 'company' ? areas : undefined,
    people: peopleRows,
    company,
    alerts,
  };
}

async function companyAggregate(workspaceId: string, period: string) {
  const reviews = await prisma.performanceReview.findMany({
    where: { workspaceId, reviewPeriod: period, user: { deletedAt: null, role: { not: 'ADMIN' } } },
    select: { overallPerformanceScore: true, overallProductivityIndex: true },
  });
  return {
    performance: mean(reviews.map((r) => r.overallPerformanceScore)),
    productivity: mean(reviews.map((r) => r.overallProductivityIndex)),
  };
}
