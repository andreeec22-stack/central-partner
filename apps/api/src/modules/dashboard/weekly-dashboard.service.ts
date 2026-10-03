import { notFound } from '../../lib/errors';
import { canSeeDepartment, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import type { Semaphore, Week, WeekKpiSnapshot } from '@prisma/client';
import { recordMetric, timed } from '../../lib/metrics';
import type { AuthUser } from '../../types';
import { COMPANY_KEY } from '../weeks/kpi-snapshot';
import type { WeekData, WeekDepartment } from '../weeks/week-data';
import { currentWeek, presentWeek, resolveWeek, weekData } from '../weeks/weeks.service';

// The director's view of a week: company cards, the per-area table, the data
// behind the four charts, and the Excel export. Archived weeks come from their
// frozen snapshot; the open week is computed live.

const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
const TASK_SEMAPHORES = ['GREEN', 'YELLOW', 'RED', 'GRAY'] as const;

function areaRow(d: WeekDepartment) {
  return {
    id: d.id,
    name: d.name,
    color: d.color,
    head: d.head,
    tasks: d.metrics.tasks,
    kpis: d.metrics.kpis,
    functions: d.metrics.functions,
    taskProgress: d.metrics.taskProgress,
    kpiCompliance: d.metrics.kpiCompliance,
    functionCompliance: d.metrics.functionCompliance,
    index: d.metrics.index,
    semaphore: d.metrics.semaphore,
  };
}

function summarize(data: WeekData) {
  const tasks = data.departments.flatMap((d) => d.tasks);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const bySemaphore = Object.fromEntries(TASK_SEMAPHORES.map((s) => [s, tasks.filter((t) => t.semaphore === s).length]));
  // KPIs already recorded and below 90%, worst first.
  const criticalKpis = data.departments
    .flatMap((d) => d.kpis.filter((k) => k.semaphore === 'RED' || k.semaphore === 'YELLOW').map((k) => ({ ...k, department: { id: d.id, name: d.name } })))
    .sort((a, b) => (a.completion ?? 0) - (b.completion ?? 0))
    .slice(0, 10);
  return { byStatus, bySemaphore, criticalKpis };
}

async function scopedWeekData(user: AuthUser, weekRef: string | undefined, departmentId?: string) {
  const week = await resolveWeek(user, weekRef);
  const data = await weekData(user, week);
  if (departmentId) {
    const scope = await departmentScope(user);
    if (!canSeeDepartment(scope, departmentId)) throw notFound('Department');
    data.departments = data.departments.filter((d) => d.id === departmentId);
  }
  return { week, data };
}

export async function weekDashboard(user: AuthUser, weekRef: string | undefined, departmentId?: string) {
  const { week, data } = await scopedWeekData(user, weekRef, departmentId);
  const { byStatus, bySemaphore, criticalKpis } = summarize(data);
  // With a department filter the "company" cards describe just that area.
  const overall = departmentId ? { ...data.overall, ...pickOverall(data.departments[0]) } : data.overall;
  return {
    week: { ...data.week, archivedAt: week.archivedAt },
    today: data.today,
    cards: {
      index: overall.index,
      semaphore: overall.semaphore,
      totalTasks: overall.tasks.total,
      doneTasks: overall.tasks.done,
      overdueTasks: overall.tasks.overdue,
      blockedTasks: overall.tasks.blocked,
      taskProgress: overall.taskProgress,
      kpiCompliance: overall.kpiCompliance,
      functionCompliance: overall.functionCompliance,
      areasBySemaphore: overall.areasBySemaphore,
    },
    departments: data.departments.map(areaRow),
    charts: { taskStatus: byStatus, taskSemaphore: bySemaphore, criticalKpis },
    generatedAt: data.generatedAt,
  };
}

function pickOverall(d: WeekDepartment | undefined) {
  if (!d) return {};
  const m = d.metrics;
  return {
    taskProgress: m.taskProgress,
    kpiCompliance: m.kpiCompliance,
    functionCompliance: m.functionCompliance,
    index: m.index,
    semaphore: m.semaphore,
    tasks: m.tasks,
    areasBySemaphore: { GREEN: 0, YELLOW: 0, RED: 0, NONE: 0, [m.semaphore ?? 'NONE']: 1 },
  };
}

// The area sheet: its tasks, KPIs and functions for the week, with its index.
export async function departmentWeek(user: AuthUser, departmentId: string, weekRef: string | undefined) {
  const { week, data } = await scopedWeekData(user, weekRef, departmentId);
  const department = data.departments[0];
  if (!department) throw notFound('Department');
  return { week: { ...data.week, archivedAt: week.archivedAt }, today: data.today, department };
}

async function assertVisibleArea(user: AuthUser, departmentId: string | undefined) {
  if (!departmentId) return;
  const scope = await departmentScope(user);
  if (!canSeeDepartment(scope, departmentId)) throw notFound('Department');
}


// ─── Per-week headline numbers ──────────────────────────────────────────────
// Closed weeks come from their KPI snapshot rows (MVP Fase 4) — a single query
// for all of them; the open week, and any closed week without snapshot rows,
// from weekData (live / full archive JSON). Departments respect the viewer's scope.

interface Numbers {
  index: number | null;
  taskProgress: number | null;
  kpiCompliance: number | null;
  functionCompliance: number | null;
  semaphore: Semaphore | null;
  tasks: { total: number; done: number; overdue: number };
}
interface WeekNumbers {
  mondayDate: string;
  saturdayDate: string;
  overall: Numbers;
  departments: { id: string; name: string; metrics: Numbers }[];
}

const fromSnapshot = (r: WeekKpiSnapshot): Numbers => ({
  index: r.indexValue,
  taskProgress: r.taskProgress,
  kpiCompliance: r.kpiCompliance,
  functionCompliance: r.functionCompliance,
  semaphore: r.semaphore,
  tasks: { total: r.tasksTotal, done: r.tasksDone, overdue: r.tasksOverdue },
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (day: string, n: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000));

async function weekNumbers(user: AuthUser, weeks: Week[]): Promise<Map<string, WeekNumbers>> {
  const scope = await departmentScope(user);
  const closed = weeks.filter((w) => w.status === 'ARCHIVED');
  const rows = closed.length ? await prisma.weekKpiSnapshot.findMany({ where: { weekId: { in: closed.map((w) => w.id) } } }) : [];
  const byWeek = new Map<string, WeekKpiSnapshot[]>();
  for (const r of rows) byWeek.set(r.weekId, [...(byWeek.get(r.weekId) ?? []), r]);

  const out = new Map<string, WeekNumbers>();
  for (const week of weeks) {
    const snap = byWeek.get(week.id);
    const company = snap?.find((r) => r.departmentKey === COMPANY_KEY);
    if (company) {
      recordMetric('week_history_snapshot_hit');
      const monday = iso(week.mondayDate);
      out.set(week.id, {
        mondayDate: monday,
        saturdayDate: plusDays(monday, 5),
        overall: fromSnapshot(company),
        departments: snap!
          .filter((r) => r.departmentKey !== COMPANY_KEY && canSeeDepartment(scope, r.departmentKey))
          .sort((a, b) => (a.departmentName ?? '').localeCompare(b.departmentName ?? '', 'es'))
          .map((r) => ({ id: r.departmentKey, name: r.departmentName ?? '', metrics: fromSnapshot(r) })),
      });
      continue;
    }
    if (week.status === 'ARCHIVED') recordMetric('week_history_snapshot_miss');
    const data = await weekData(user, week);
    out.set(week.id, { mondayDate: data.week.mondayDate, saturdayDate: data.week.saturdayDate, overall: data.overall, departments: data.departments });
  }
  return out;
}

// The index week by week, oldest first, ending with the current week.
export async function trends(user: AuthUser, count: number, departmentId?: string) {
  await assertVisibleArea(user, departmentId);
  const current = await currentWeek(user.workspaceId, user.workspaceTimezone);
  const weeks = await prisma.week.findMany({
    where: { workspaceId: user.workspaceId, mondayDate: { lte: current.mondayDate } },
    orderBy: { mondayDate: 'desc' },
    take: count,
  });

  const ordered = weeks.reverse();
  const numbers = await timed('week_trends', () => weekNumbers(user, ordered));
  const points = [];
  for (const week of ordered) {
    const data = numbers.get(week.id)!;
    const departments = data.departments.filter((d) => !departmentId || d.id === departmentId);
    const focus = departmentId ? (departments[0]?.metrics ?? null) : null;
    const source = focus ?? data.overall;
    points.push({
      week: presentWeek(week),
      index: source.index,
      taskProgress: source.taskProgress,
      kpiCompliance: source.kpiCompliance,
      functionCompliance: source.functionCompliance,
      semaphore: source.semaphore,
      departments: departments.map((d) => ({ id: d.id, name: d.name, index: d.metrics.index, semaphore: d.metrics.semaphore })),
    });
  }
  return { data: points };
}

// ─── History (the four dashboard charts) ────────────────────────────────────

// Percentages 0–100 with one decimal, as the charts plot them.
const percent = (fraction: number | null) => (fraction === null ? null : Math.round(fraction * 1000) / 10);

// The last `limit` closed weeks (from their frozen archives) plus, by default,
// the current one — oldest first. With `departmentId`, every number is that area's.
//   compliancePercentage = completed ÷ total tasks of the week
export async function weekHistory(user: AuthUser, opts: { limit: number; includeCurrent: boolean; departmentId?: string }) {
  await assertVisibleArea(user, opts.departmentId);
  const current = await currentWeek(user.workspaceId, user.workspaceTimezone);
  const closed = await prisma.week.findMany({
    where: { workspaceId: user.workspaceId, status: 'ARCHIVED', mondayDate: { lt: current.mondayDate } },
    orderBy: { mondayDate: 'desc' },
    take: opts.limit,
  });
  const weeks = [...closed.reverse(), ...(opts.includeCurrent ? [current] : [])];

  const numbers = await timed('week_history', () => weekNumbers(user, weeks));
  const result = [];
  for (const week of weeks) {
    const data = numbers.get(week.id)!;
    const departments = data.departments.filter((d) => !opts.departmentId || d.id === opts.departmentId);
    const focus = opts.departmentId ? (departments[0]?.metrics ?? null) : null;
    const source = focus ?? data.overall;
    const tasks = focus ? focus.tasks : data.overall.tasks;
    result.push({
      weekId: week.id,
      weekNumber: week.weekNumber,
      year: week.year,
      mondayDate: data.mondayDate,
      saturdayDate: data.saturdayDate,
      status: week.status,
      metrics: {
        indexGeneral: percent(source.index),
        totalTasks: tasks.total,
        completedTasks: tasks.done,
        delayedTasks: tasks.overdue,
        compliancePercentage: tasks.total ? Math.round((tasks.done / tasks.total) * 1000) / 10 : null,
        taskProgress: percent(source.taskProgress),
        kpiCompliance: percent(source.kpiCompliance),
        functionCompliance: percent(source.functionCompliance),
        semaphore: source.semaphore,
      },
      departmentMetrics: departments.map((d) => ({
        departmentId: d.id,
        departmentName: d.name,
        tasksTotal: d.metrics.tasks.total,
        tasksCompleted: d.metrics.tasks.done,
        tasksDelayed: d.metrics.tasks.overdue,
        kpiIndex: percent(d.metrics.index),
        semaphore: d.metrics.semaphore,
      })),
    });
  }
  return { weeks: result };
}

// Shared with the Excel export.
export { assertVisibleArea, scopedWeekData };
