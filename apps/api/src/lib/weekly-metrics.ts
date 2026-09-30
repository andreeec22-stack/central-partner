import type { FunctionFulfillment, Semaphore } from '@prisma/client';
import { semaphoreFor } from './semaphore';
import { localDay, saturdayOf } from './week';

// The director's weekly index, as in the Excel sheet:
//   ① tasks     = average progress of the tasks whose day has arrived (today included)
//   ② KPIs      = average completion of the KPIs with a recorded real value
//   ③ functions = average of Sí (1) / Parcial (0.5) / No (0); "no aplica" and unmarked excluded
//   index       = average of ①②③ — of the ones that exist so far, so on a Tuesday
//                 (no KPIs or functions filled yet) the index is just ①.
// All values are fractions 0–1; KPI completion may exceed 1 but counts as 1 in ②
// so over-delivering one KPI can't hide missing another.

export interface TaskLike {
  progress: number;
  dueDate: Date | null;
}

// Task semaphore by date: GREEN done · RED its day passed · YELLOW due today · GRAY not yet.
// Undated tasks are due on their week's Saturday.
export function taskDay(task: TaskLike, weekMonday: string | null, timeZone: string): string | null {
  if (task.dueDate) return localDay(task.dueDate, timeZone);
  return weekMonday ? saturdayOf(weekMonday) : null;
}

export function taskSemaphore(task: TaskLike, weekMonday: string | null, today: string, timeZone: string): Semaphore {
  if (task.progress >= 100) return 'GREEN';
  const day = taskDay(task, weekMonday, timeZone);
  if (!day) return 'GRAY';
  if (day < today) return 'RED';
  return day === today ? 'YELLOW' : 'GRAY';
}

export function kpiCompletion(target: number, actual: number | null, lesserIsBetter: boolean): number | null {
  if (actual === null) return null;
  if (lesserIsBetter) {
    // "At most `target`": at or under it is 100%; over it scales down.
    if (actual <= target) return 1;
    return target <= 0 ? 0 : target / actual;
  }
  if (target <= 0) return actual >= target ? 1 : 0;
  return Math.max(0, actual / target);
}

export const FULFILLMENT_SCORE: Record<FunctionFulfillment, number | null> = {
  YES: 1,
  PARTIAL: 0.5,
  NO: 0,
  NOT_APPLICABLE: null,
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const mean = (values: number[]) => (values.length ? round4(values.reduce((a, b) => a + b, 0) / values.length) : null);

export interface AreaMetricsInput {
  tasks: (TaskLike & { status?: string })[];
  kpis: { target: number; actual: number | null; lesserIsBetter: boolean }[];
  functions: { fulfilled: FunctionFulfillment | null }[];
  weekMonday: string;
  today: string;
  timeZone: string;
}

export interface AreaMetrics {
  tasks: { total: number; due: number; done: number; overdue: number; blocked: number };
  kpis: { total: number; recorded: number };
  functions: { total: number; marked: number };
  taskProgress: number | null; // ①
  kpiCompliance: number | null; // ②
  functionCompliance: number | null; // ③
  index: number | null;
  semaphore: Semaphore | null;
}

export function areaMetrics({ tasks, kpis, functions, weekMonday, today, timeZone }: AreaMetricsInput): AreaMetrics {
  const due = tasks.filter((t) => {
    const day = taskDay(t, weekMonday, timeZone);
    return day !== null && day <= today;
  });
  const recorded = kpis.map((k) => kpiCompletion(k.target, k.actual, k.lesserIsBetter)).filter((v): v is number => v !== null);
  const scores = functions.map((f) => (f.fulfilled ? FULFILLMENT_SCORE[f.fulfilled] : null)).filter((v): v is number => v !== null);

  const taskProgress = mean(due.map((t) => t.progress / 100));
  const kpiCompliance = mean(recorded.map((v) => Math.min(v, 1)));
  const functionCompliance = mean(scores);
  const index = mean([taskProgress, kpiCompliance, functionCompliance].filter((v): v is number => v !== null));

  return {
    tasks: {
      total: tasks.length,
      due: due.length,
      done: tasks.filter((t) => t.progress >= 100).length,
      overdue: tasks.filter((t) => taskSemaphore(t, weekMonday, today, timeZone) === 'RED').length,
      blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
    },
    kpis: { total: kpis.length, recorded: recorded.length },
    functions: { total: functions.length, marked: functions.filter((f) => f.fulfilled !== null).length },
    taskProgress,
    kpiCompliance,
    functionCompliance,
    index,
    semaphore: index === null ? null : semaphoreFor(index * 100),
  };
}
