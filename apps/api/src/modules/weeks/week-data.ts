import type { Prisma, Semaphore, Week } from '@prisma/client';
import type { Tx } from '../../lib/prisma';
import { semaphoreFor } from '../../lib/semaphore';
import { dateToDay, localDay, saturdayOf } from '../../lib/week';
import { areaMetrics, kpiCompletion, taskDay, taskSemaphore, type AreaMetrics } from '../../lib/weekly-metrics';

// One function computes everything a week shows — per area: tasks, KPIs,
// functions and the ①②③ index. The dashboard calls it live; closing a week
// stores its output as the archive, so an archived week reads exactly as it
// did when it was closed (its unfinished tasks have moved on by then).

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export type Trend = 'UP' | 'DOWN' | 'STABLE';

export interface WeekTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  progress: number;
  dueDate: string | null;
  day: string | null;
  semaphore: Semaphore;
  blockReason: string | null;
  assignedTo: { id: string; displayName: string } | null;
  carriedFrom: { weekNumber: number; year: number } | null;
  sourceType: string;
  observation: string | null;
}

export interface WeekKpi {
  id: string;
  title: string;
  description: string | null;
  type: string;
  unit: string | null;
  target: number;
  actual: number | null;
  lesserIsBetter: boolean;
  order: number;
  completion: number | null;
  semaphore: Semaphore | null;
  trend: Trend | null;
  recordedAt: Date | null;
}

export interface WeekFunction {
  id: string;
  title: string;
  description: string | null;
  frequency: string;
  fulfilled: string | null;
  observation: string | null;
  order: number;
  markedAt: Date | null;
}

export interface WeekDepartment {
  id: string;
  name: string;
  color: string | null;
  head: { id: string; displayName: string } | null;
  metrics: AreaMetrics;
  tasks: WeekTask[];
  kpis: WeekKpi[];
  functions: WeekFunction[];
}

export interface WeekData {
  week: { id: string; mondayDate: string; saturdayDate: string; weekNumber: number; year: number; status: string };
  today: string;
  departments: WeekDepartment[];
  overall: {
    taskProgress: number | null;
    kpiCompliance: number | null;
    functionCompliance: number | null;
    index: number | null;
    semaphore: Semaphore | null;
    tasks: AreaMetrics['tasks'];
    areasBySemaphore: Record<'GREEN' | 'YELLOW' | 'RED' | 'NONE', number>;
  };
  generatedAt: Date;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? round4(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

export function trendOf(current: number | null, previous: number | null): Trend | null {
  if (current === null || previous === null) return null;
  if (current - previous > 0.01) return 'UP';
  if (previous - current > 0.01) return 'DOWN';
  return 'STABLE';
}

export async function buildWeekData(
  db: Tx,
  week: Week,
  timeZone: string,
  departmentIds: string[] | null, // null = all
  now = new Date(),
): Promise<WeekData> {
  const monday = dateToDay(week.mondayDate);
  const today = localDay(now, timeZone);
  const deptFilter = departmentIds ? { in: departmentIds } : undefined;

  const [departments, tasks, kpis, functions, previousWeek] = await Promise.all([
    db.department.findMany({
      where: { workspaceId: week.workspaceId, deletedAt: null, id: deptFilter },
      select: { id: true, name: true, color: true, head: { select: { id: true, displayName: true, deletedAt: true } } },
      orderBy: { name: 'asc' },
    }),
    db.task.findMany({
      where: { weekId: week.id, deletedAt: null, departmentId: deptFilter },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        progress: true,
        dueDate: true,
        blockReason: true,
        departmentId: true,
        sourceType: true,
        assignedTo: { select: { id: true, displayName: true } },
        carriedFrom: { select: { weekNumber: true, year: true } },
        observations: { where: { weekId: week.id }, select: { observation: true } },
      },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    }),
    db.kpi.findMany({ where: { weekId: week.id, departmentId: deptFilter }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
    db.departmentFunction.findMany({ where: { weekId: week.id, departmentId: deptFilter }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
    db.week.findFirst({
      where: { workspaceId: week.workspaceId, mondayDate: { lt: week.mondayDate } },
      orderBy: { mondayDate: 'desc' },
      select: { id: true },
    }),
  ]);

  // Last week's completion per department + KPI title, for the trend arrow.
  const previousKpis = previousWeek
    ? await db.kpi.findMany({
        where: { weekId: previousWeek.id, departmentId: deptFilter },
        select: { departmentId: true, title: true, target: true, actual: true, lesserIsBetter: true },
      })
    : [];
  const previousCompletion = new Map(
    previousKpis.map((k) => [`${k.departmentId}:${normalize(k.title)}`, kpiCompletion(Number(k.target), num(k.actual), k.lesserIsBetter)]),
  );

  const result: WeekDepartment[] = departments.map((d) => {
    const deptTasks = tasks.filter((t) => t.departmentId === d.id);
    const deptKpis = kpis.filter((k) => k.departmentId === d.id);
    const deptFunctions = functions.filter((f) => f.departmentId === d.id);
    const metrics = areaMetrics({
      tasks: deptTasks,
      kpis: deptKpis.map((k) => ({ target: Number(k.target), actual: num(k.actual), lesserIsBetter: k.lesserIsBetter })),
      functions: deptFunctions,
      weekMonday: monday,
      today,
      timeZone,
    });
    return {
      id: d.id,
      name: d.name,
      color: d.color,
      head: d.head && !d.head.deletedAt ? { id: d.head.id, displayName: d.head.displayName } : null,
      metrics,
      tasks: deptTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        progress: t.progress,
        dueDate: t.dueDate?.toISOString() ?? null,
        day: taskDay(t, monday, timeZone),
        semaphore: taskSemaphore(t, monday, today, timeZone),
        blockReason: t.blockReason,
        assignedTo: t.assignedTo,
        carriedFrom: t.carriedFrom,
        sourceType: t.sourceType,
        observation: t.observations[0]?.observation ?? null,
      })),
      kpis: deptKpis.map((k) => {
        const completion = kpiCompletion(Number(k.target), num(k.actual), k.lesserIsBetter);
        return {
          id: k.id,
          title: k.title,
          description: k.description,
          type: k.type,
          unit: k.unit,
          target: Number(k.target),
          actual: num(k.actual),
          lesserIsBetter: k.lesserIsBetter,
          order: k.order,
          completion: completion === null ? null : round4(completion),
          semaphore: completion === null ? null : semaphoreFor(completion * 100),
          trend: trendOf(completion, previousCompletion.get(`${d.id}:${normalize(k.title)}`) ?? null),
          recordedAt: k.recordedAt,
        };
      }),
      functions: deptFunctions.map((f) => ({
        id: f.id,
        title: f.title,
        description: f.description,
        frequency: f.frequency,
        fulfilled: f.fulfilled,
        observation: f.observation,
        order: f.order,
        markedAt: f.markedAt,
      })),
    };
  });

  // The company index weighs every area equally, like the director's sheet.
  const areas = result.map((d) => d.metrics);
  const index = mean(areas.map((m) => m.index));
  const areasBySemaphore = { GREEN: 0, YELLOW: 0, RED: 0, NONE: 0 };
  for (const m of areas) areasBySemaphore[m.semaphore === 'GRAY' || !m.semaphore ? 'NONE' : m.semaphore]++;
  const sum = (k: keyof AreaMetrics['tasks']) => areas.reduce((n, m) => n + m.tasks[k], 0);

  return {
    week: {
      id: week.id,
      mondayDate: monday,
      saturdayDate: saturdayOf(monday),
      weekNumber: week.weekNumber,
      year: week.year,
      status: week.status,
    },
    today,
    departments: result,
    overall: {
      taskProgress: mean(areas.map((m) => m.taskProgress)),
      kpiCompliance: mean(areas.map((m) => m.kpiCompliance)),
      functionCompliance: mean(areas.map((m) => m.functionCompliance)),
      index,
      semaphore: index === null ? null : semaphoreFor(index * 100),
      tasks: { total: sum('total'), due: sum('due'), done: sum('done'), overdue: sum('overdue'), blocked: sum('blocked') },
      areasBySemaphore,
    },
    generatedAt: now,
  };
}
