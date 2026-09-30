import type { Semaphore } from '@prisma/client';

// Daily progress is picked from these steps (Excel "SOLO 3 COSAS" pattern).
export const PROGRESS_STEPS = [0, 25, 50, 75, 100] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export function isProgressStep(value: number): value is ProgressStep {
  return (PROGRESS_STEPS as readonly number[]).includes(value);
}

// Area index and KPI semaphore, from a percentage: GREEN >= 90, YELLOW 70–89,
// RED < 70. (Tasks use the date-based rule in weekly-metrics.) Never branded.
export function semaphoreFor(percent: number): Semaphore {
  if (percent >= 90) return 'GREEN';
  if (percent >= 70) return 'YELLOW';
  return 'RED';
}
