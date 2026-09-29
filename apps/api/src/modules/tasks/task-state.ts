import type { Priority, Semaphore, TaskStatus } from '@prisma/client';
import { validationError } from '../../lib/errors';
import { isProgressStep, semaphoreFor } from '../../lib/semaphore';

// Pure transition rules for status / progress / blocking / completion metrics.
// Kept free of I/O so every rule is unit-tested.
//
//   • progress must be one of 0/25/50/75/100; semaphore is always derived from it
//   • status DONE ⇔ progress 100 (setting either one implies the other)
//   • progress > 0 on a TODO task moves it to IN_PROGRESS
//   • dropping progress below 100 on a DONE task reopens it (IN_PROGRESS)
//   • entering BLOCKED requires a non-empty blockReason; leaving it clears the block fields
//   • completion metrics are stamped on DONE and cleared if the task is reopened

export interface TaskStateSnapshot {
  status: TaskStatus;
  progress: number;
  priority: Priority;
  blockReason: string | null;
  blockedSince: Date | null;
  blockedByUserId: string | null;
  actualStartDate: Date | null;
  actualCompletionDate: Date | null;
  actualDurationHours: number | null;
  timeToCompletionHours: number | null;
  completionDelayDays: number | null;
  priorityAtCompletion: Priority | null;
  createdAt: Date;
  dueDate: Date | null;
  kpiActual: string | null;
}

export interface TaskStatePatch {
  status?: TaskStatus;
  progress?: number;
  priority?: Priority;
  blockReason?: string | null;
  dueDate?: Date | null;
  kpiActual?: string | null;
}

export interface TaskStateChange {
  status: TaskStatus;
  progress: number;
  semaphore: Semaphore;
  blockReason: string | null;
  blockedSince: Date | null;
  blockedByUserId: string | null;
  wasBlocked?: true;
  actualStartDate: Date | null;
  actualCompletionDate: Date | null;
  actualDurationHours: number | null;
  timeToCompletionHours: number | null;
  completionDelayDays: number | null;
  priorityAtCompletion: Priority | null;
  kpiRecordedAt?: Date | null;
}

export interface TaskStateEvents {
  progressChanged: boolean;
  blocked: boolean;
  unblocked: boolean;
  completed: boolean;
  reopened: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const round2 = (n: number) => Math.round(n * 100) / 100;

function resolveStatusAndProgress(cur: TaskStateSnapshot, patch: TaskStatePatch): { status: TaskStatus; progress: number } {
  if (patch.progress !== undefined && !isProgressStep(patch.progress)) {
    throw validationError('Progress must be 0, 25, 50, 75 or 100', [{ field: 'progress', message: 'invalid step' }]);
  }
  let status = patch.status ?? cur.status;
  let progress = patch.progress ?? cur.progress;

  if (patch.status === 'DONE') {
    if (patch.progress !== undefined && patch.progress !== 100) {
      throw validationError('A DONE task must be at 100% progress', [{ field: 'progress', message: 'must be 100' }]);
    }
    progress = 100;
  } else if (patch.status === undefined && patch.progress !== undefined) {
    if (patch.progress === 100 && cur.status !== 'BLOCKED') status = 'DONE';
    else if (cur.status === 'DONE' && patch.progress < 100) status = 'IN_PROGRESS';
    else if (cur.status === 'TODO' && patch.progress > 0) status = 'IN_PROGRESS';
  } else if (patch.status !== undefined && cur.status === 'DONE' && patch.progress === undefined) {
    // Reopening a finished task without saying where it stands: back to 0 for
    // TODO, otherwise 75% ("almost there") so it no longer reads as complete.
    progress = patch.status === 'TODO' ? 0 : 75;
  }

  // 100% means done. Only a blocked task may sit at 100% without being DONE
  // (e.g. finished work waiting on an approval).
  if (progress === 100 && (status === 'TODO' || status === 'IN_PROGRESS')) {
    throw validationError('A task at 100% must be DONE (or BLOCKED)', [{ field: 'status', message: 'inconsistent with progress' }]);
  }
  return { status, progress };
}

export function deriveTaskState(
  cur: TaskStateSnapshot,
  patch: TaskStatePatch,
  actorId: string,
  now: Date = new Date(),
): { change: TaskStateChange; events: TaskStateEvents } {
  const { status, progress } = resolveStatusAndProgress(cur, patch);
  const reason = patch.blockReason?.trim() || null;

  // ── Blocking ──
  let blockReason = cur.blockReason;
  let blockedSince = cur.blockedSince;
  let blockedByUserId = cur.blockedByUserId;
  const entering = status === 'BLOCKED' && cur.status !== 'BLOCKED';
  const leaving = status !== 'BLOCKED' && cur.status === 'BLOCKED';

  if (status === 'BLOCKED') {
    if (entering && !reason) {
      throw validationError('blockReason is required for BLOCKED status', [{ field: 'blockReason', message: 'required' }]);
    }
    if (!entering && patch.blockReason !== undefined && !reason) {
      throw validationError('A blocked task must keep a block reason', [{ field: 'blockReason', message: 'required' }]);
    }
    if (entering) {
      blockedSince = now;
      blockedByUserId = actorId;
    }
    if (reason) blockReason = reason;
  } else {
    if (reason) {
      throw validationError('blockReason only applies to BLOCKED tasks', [{ field: 'blockReason', message: 'status is not BLOCKED' }]);
    }
    blockReason = null;
    blockedSince = null;
    blockedByUserId = null;
  }

  // ── Completion metrics ──
  const completed = status === 'DONE' && cur.status !== 'DONE';
  const reopened = status !== 'DONE' && cur.status === 'DONE';
  let actualStartDate = cur.actualStartDate;
  if (!actualStartDate && (status === 'IN_PROGRESS' || status === 'DONE' || progress > 0)) actualStartDate = now;

  const change: TaskStateChange = {
    status,
    progress,
    semaphore: semaphoreFor(progress),
    blockReason,
    blockedSince,
    blockedByUserId,
    actualStartDate,
    actualCompletionDate: cur.actualCompletionDate,
    actualDurationHours: null,
    timeToCompletionHours: null,
    completionDelayDays: null,
    priorityAtCompletion: null,
  };
  if (entering) change.wasBlocked = true;

  if (completed) {
    const dueDate = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
    change.actualCompletionDate = now;
    change.actualDurationHours = round2((now.getTime() - (actualStartDate ?? now).getTime()) / HOUR);
    change.timeToCompletionHours = round2((now.getTime() - cur.createdAt.getTime()) / HOUR);
    change.completionDelayDays = dueDate ? round2((now.getTime() - dueDate.getTime()) / DAY) : null;
    change.priorityAtCompletion = patch.priority ?? cur.priority;
  } else if (status === 'DONE') {
    // Still done: the completion snapshot is history, later edits don't rewrite it.
    change.actualDurationHours = cur.actualDurationHours;
    change.timeToCompletionHours = cur.timeToCompletionHours;
    change.completionDelayDays = cur.completionDelayDays;
    change.priorityAtCompletion = cur.priorityAtCompletion;
  } else {
    change.actualCompletionDate = null;
  }

  // ── KPI ── (the Saturday "resultado real")
  if (patch.kpiActual !== undefined && (patch.kpiActual ?? null) !== cur.kpiActual) {
    change.kpiRecordedAt = patch.kpiActual ? now : null;
  }

  return {
    change,
    events: {
      progressChanged: progress !== cur.progress,
      blocked: entering,
      unblocked: leaving,
      completed,
      reopened,
    },
  };
}
