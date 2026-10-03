import type { Prisma, Semaphore } from '@prisma/client';
import { recordMetric } from '../../lib/metrics';
import type { Tx } from '../../lib/prisma';
import type { WeekData } from './week-data';

// Week KPI snapshots (MVP Fase 4): the headline numbers of a closed week, one
// row per area + one for the company, written in the closing transaction. The
// history charts read these rows instead of every week's full archive JSON
// (see weekly-dashboard.service → weekHistory / trends).

export const COMPANY_KEY = 'ALL';

interface Metrics {
  index: number | null;
  taskProgress: number | null;
  kpiCompliance: number | null;
  functionCompliance: number | null;
  semaphore: Semaphore | null;
  tasks: { total: number; due: number; done: number; overdue: number };
}

const row = (workspaceId: string, weekId: string, departmentKey: string, departmentName: string | null, m: Metrics): Prisma.WeekKpiSnapshotCreateManyInput => ({
  workspaceId,
  weekId,
  departmentKey,
  departmentName: departmentName?.slice(0, 80) ?? null,
  indexValue: m.index,
  taskProgress: m.taskProgress,
  kpiCompliance: m.kpiCompliance,
  functionCompliance: m.functionCompliance,
  semaphore: m.semaphore,
  tasksTotal: m.tasks.total,
  tasksDue: m.tasks.due,
  tasksDone: m.tasks.done,
  tasksOverdue: m.tasks.overdue,
});

// Pure: the rows a week's data produces.
export function snapshotRows(workspaceId: string, weekId: string, data: WeekData): Prisma.WeekKpiSnapshotCreateManyInput[] {
  return [row(workspaceId, weekId, COMPANY_KEY, null, data.overall), ...data.departments.map((d) => row(workspaceId, weekId, d.id, d.name, d.metrics))];
}

// Idempotent: a week already snapshotted keeps its first (closing) numbers.
export async function takeKpiSnapshot(db: Tx, workspaceId: string, weekId: string, data: WeekData) {
  const { count } = await db.weekKpiSnapshot.createMany({ data: snapshotRows(workspaceId, weekId, data), skipDuplicates: true });
  if (count) recordMetric('kpi_snapshot_rows_created', count);
  return count;
}
