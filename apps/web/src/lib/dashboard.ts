import type { DashboardMetrics } from '../components/dashboard/MetricsGrid';
import type { DepartmentRow } from '../components/dashboard/DepartmentTableRow';
import { toSemaphoreType } from '../components/shared/SemaphoreIcon';
import { toPercent } from './format';
import type { TrendPoint, WeekDashboard } from './types';

// The API speaks fractions (0.725) and upper-case semaphores; the dashboard
// components take percentages (72.5) and 'green'|'yellow'|'red'|'gray'.

export function toMetrics(d: WeekDashboard, trend?: TrendPoint[]): DashboardMetrics {
  // Last point is this week, the one before it last week.
  const previous = trend && trend.length >= 2 ? trend[trend.length - 2]!.index : null;
  const current = d.cards.index;
  return {
    index: toPercent(current),
    totalTasks: d.cards.totalTasks,
    completedTasks: d.cards.doneTasks,
    overdueTasks: d.cards.overdueTasks,
    metric1: toPercent(d.cards.taskProgress),
    metric2: toPercent(d.cards.kpiCompliance),
    metric3: toPercent(d.cards.functionCompliance),
    indexDelta: current !== null && previous !== null ? toPercent(current - previous) : null,
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

// "28 sept – 3 oct"
export function weekRangeLabel(mondayDate: string, saturdayDate: string): string {
  const f = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f.format(new Date(`${mondayDate}T00:00:00Z`))} – ${f.format(new Date(`${saturdayDate}T00:00:00Z`))}`;
}
