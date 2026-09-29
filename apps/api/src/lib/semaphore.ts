import type { Semaphore } from '@prisma/client';

// Daily progress is picked from these steps (Excel "SOLO 3 COSAS" pattern).
export const PROGRESS_STEPS = [0, 25, 50, 75, 100] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export function isProgressStep(value: number): value is ProgressStep {
  return (PROGRESS_STEPS as readonly number[]).includes(value);
}

// GREEN >= 90, YELLOW 70–89, RED < 70. Colors are fixed, never branded.
export function semaphoreFor(progress: number): Semaphore {
  if (progress >= 90) return 'GREEN';
  if (progress >= 70) return 'YELLOW';
  return 'RED';
}
