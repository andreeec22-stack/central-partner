import { forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { addDays, dateToDay, dayToDate, localDay, mondayOfDay } from '../../lib/week';
import { kpiCompletion, taskDay } from '../../lib/weekly-metrics';
import type { AuthUser } from '../../types';
import { calculateProductivityIndex, type PerformanceMetrics } from '../surveys/scoring';

// Module 1 — a person's productivity over the last N weeks, from their tasks
// and their area's KPIs (0–100 each; null = nothing to measure):
//   completion_rate      tasks whose day has arrived that are at 100%
//   on_time_rate         of the completed ones with a known completion date,
//                        those finished on or before their day
//   kpi_achievement      average completion of the area's recorded KPIs (② of
//                        the weekly index), each capped at 100%
//   collaboration_score  no reliable source yet → always null (drops out of the index)

export const DEFAULT_WINDOW_WEEKS = 4;

export interface PerformanceReport {
  userId: string;
  departmentId: string | null;
  period: { from: string; to: string; weeks: number };
  metrics: PerformanceMetrics;
  tasks: { due: number; completed: number; onTime: number; late: number; completionDateUnknown: number };
  productivityIndex: number | null;
  generatedAt: string;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// Who can see a person's numbers: ADMIN, the person, and the JEFE_AREA of the
// person's own department (visibility grants over other areas don't extend to HR data).
export function canSeePerformanceOf(viewer: AuthUser, subject: { id: string; departmentId: string | null }) {
  if (viewer.role === 'ADMIN' || viewer.id === subject.id) return true;
  return viewer.role === 'JEFE_AREA' && !!viewer.departmentId && viewer.departmentId === subject.departmentId;
}

export async function getPerformanceMetrics(
  userId: string,
  workspaceId: string,
  timeZone: string,
  weeks = DEFAULT_WINDOW_WEEKS,
  now = new Date(),
): Promise<PerformanceReport> {
  const subject = await prisma.user.findFirst({ where: { id: userId, workspaceId, deletedAt: null }, select: { id: true, departmentId: true } });
  if (!subject) throw notFound('User');

  const to = localDay(now, timeZone);
  const from = addDays(to, -7 * weeks + 1);

  const [tasks, kpis] = await Promise.all([
    prisma.task.findMany({
      where: {
        workspaceId,
        assignedToId: userId,
        deletedAt: null,
        OR: [
          // A dated task's local day can be one calendar day off its UTC date.
          { dueDate: { gte: dayToDate(addDays(from, -1)), lt: dayToDate(addDays(to, 2)) } },
          { dueDate: null, week: { mondayDate: { gte: dayToDate(mondayOfDay(from)), lte: dayToDate(to) } } },
        ],
      },
      select: { progress: true, dueDate: true, actualCompletionDate: true, week: { select: { mondayDate: true } } },
    }),
    subject.departmentId
      ? prisma.kpi.findMany({
          where: {
            workspaceId,
            departmentId: subject.departmentId,
            actual: { not: null },
            week: { mondayDate: { gte: dayToDate(mondayOfDay(from)), lte: dayToDate(to) } },
          },
          select: { target: true, actual: true, lesserIsBetter: true },
        })
      : Promise.resolve([]),
  ]);

  let due = 0;
  let completed = 0;
  let onTime = 0;
  let late = 0;
  let completionDateUnknown = 0;
  for (const t of tasks) {
    const day = taskDay(t, t.week ? dateToDay(t.week.mondayDate) : null, timeZone);
    if (!day || day < from || day > to) continue;
    due++;
    if (t.progress < 100) continue;
    completed++;
    if (!t.actualCompletionDate) completionDateUnknown++;
    else if (localDay(t.actualCompletionDate, timeZone) <= day) onTime++;
    else late++;
  }

  const kpiValues = kpis
    .map((k) => kpiCompletion(Number(k.target), Number(k.actual), k.lesserIsBetter))
    .filter((v): v is number => v !== null)
    .map((v) => Math.min(1, v));

  const metrics: PerformanceMetrics = {
    completion_rate: pct(completed, due),
    on_time_rate: pct(onTime, onTime + late),
    collaboration_score: null,
    kpi_achievement: kpiValues.length ? Math.round((kpiValues.reduce((a, b) => a + b, 0) / kpiValues.length) * 1000) / 10 : null,
  };

  return {
    userId,
    departmentId: subject.departmentId,
    period: { from, to, weeks },
    metrics,
    tasks: { due, completed, onTime, late, completionDateUnknown },
    productivityIndex: calculateProductivityIndex(metrics),
    generatedAt: now.toISOString(),
  };
}

// GET /workspaces/:id/team/:userId/performance
export async function performanceFor(viewer: AuthUser, workspaceId: string, userId: string, weeks: number) {
  if (workspaceId !== viewer.workspaceId) throw notFound('Workspace');
  const subject = await prisma.user.findFirst({ where: { id: userId, workspaceId, deletedAt: null }, select: { id: true, departmentId: true } });
  if (!subject) throw notFound('User');
  if (!canSeePerformanceOf(viewer, subject)) throw forbidden('Solo el director, el jefe del área o la propia persona ven su desempeño');
  return getPerformanceMetrics(userId, workspaceId, viewer.workspaceTimezone, weeks);
}
