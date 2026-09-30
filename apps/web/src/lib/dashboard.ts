import type { DashboardMetrics } from '../components/dashboard/MetricsGrid';
import type { DepartmentRow } from '../components/dashboard/DepartmentTableRow';
import { toSemaphoreType, type SemaphoreType } from '../components/shared/SemaphoreIcon';
import { toPercent } from './format';
import type { HistoryWeek, WeekDashboard } from './types';

// The API speaks fractions (0.725) and upper-case semaphores in the week
// dashboard, percentages in the history; the components take percentages
// (72.5) and 'green'|'yellow'|'red'|'gray'.

// `previousIndex`: last week's index in percent, for the trend arrow.
export function toMetrics(d: WeekDashboard, previousIndex?: number | null): DashboardMetrics {
  const index = toPercent(d.cards.index);
  return {
    index,
    totalTasks: d.cards.totalTasks,
    completedTasks: d.cards.doneTasks,
    overdueTasks: d.cards.overdueTasks,
    metric1: toPercent(d.cards.taskProgress),
    metric2: toPercent(d.cards.kpiCompliance),
    metric3: toPercent(d.cards.functionCompliance),
    indexDelta: index !== null && previousIndex !== null && previousIndex !== undefined ? Math.round((index - previousIndex) * 10) / 10 : null,
  };
}

export function toDepartmentRows(d: WeekDashboard): DepartmentRow[] {
  return d.departments.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    boss: a.head?.displayName ?? null,
    totalTasks: a.tasks.total,
    completion: a.tasks.done,
    overdue: a.tasks.overdue,
    metric1: toPercent(a.taskProgress),
    metric2: toPercent(a.kpiCompliance),
    metric3: toPercent(a.functionCompliance),
    departmentIndex: toPercent(a.index),
    semaphore: toSemaphoreType(a.semaphore),
  }));
}

// One point per week for the charts.
export interface HistoryPoint {
  weekId: string;
  label: string; // "S38"
  range: string; // "21 sept – 26 sept"
  index: number | null;
  semaphore: SemaphoreType;
  completed: number;
  total: number;
  delayed: number;
  compliance: number | null;
  current: boolean;
}

export function toHistoryPoints(weeks: HistoryWeek[]): HistoryPoint[] {
  return weeks.map((w) => ({
    weekId: w.weekId,
    label: `S${w.weekNumber}`,
    range: weekRangeLabel(w.mondayDate, w.saturdayDate),
    index: w.metrics.indexGeneral,
    semaphore: toSemaphoreType(w.metrics.semaphore),
    completed: w.metrics.completedTasks,
    total: w.metrics.totalTasks,
    delayed: w.metrics.delayedTasks,
    compliance: w.metrics.compliancePercentage,
    current: w.status === 'ACTIVE',
  }));
}

// "28 sept – 3 oct"
export function weekRangeLabel(mondayDate: string, saturdayDate: string): string {
  const f = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f.format(new Date(`${mondayDate}T00:00:00Z`))} – ${f.format(new Date(`${saturdayDate}T00:00:00Z`))}`;
}
