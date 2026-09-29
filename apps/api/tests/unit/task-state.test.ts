import { AppError } from '../../src/lib/errors';
import { deriveTaskState, type TaskStateSnapshot } from '../../src/modules/tasks/task-state';

const created = new Date('2026-09-28T08:00:00Z');
const now = new Date('2026-09-30T12:00:00Z');

function snapshot(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    status: 'TODO',
    progress: 0,
    priority: 'MEDIUM',
    blockReason: null,
    blockedSince: null,
    blockedByUserId: null,
    actualStartDate: null,
    actualCompletionDate: null,
    actualDurationHours: null,
    timeToCompletionHours: null,
    completionDelayDays: null,
    priorityAtCompletion: null,
    createdAt: created,
    dueDate: null,
    kpiActual: null,
    ...overrides,
  };
}

const derive = (cur: TaskStateSnapshot, patch: Parameters<typeof deriveTaskState>[1]) =>
  deriveTaskState(cur, patch, 'user-1', now);

function expectValidation(fn: () => unknown, field: string) {
  try {
    fn();
    throw new Error('expected a validation error');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(422);
    expect(JSON.stringify((err as AppError).details)).toContain(field);
  }
}

describe('progress and semaphore', () => {
  it('rejects progress outside the daily steps', () => {
    expectValidation(() => derive(snapshot(), { progress: 60 }), 'progress');
  });

  it('derives the semaphore and starts the task on first progress', () => {
    const { change, events } = derive(snapshot(), { progress: 75 });
    expect(change).toMatchObject({ status: 'IN_PROGRESS', progress: 75, semaphore: 'YELLOW', actualStartDate: now });
    expect(events.progressChanged).toBe(true);
  });

  it('100% completes the task and stamps completion metrics', () => {
    const start = new Date('2026-09-29T12:00:00Z');
    const due = new Date('2026-10-01T12:00:00Z');
    const { change, events } = derive(snapshot({ status: 'IN_PROGRESS', progress: 50, actualStartDate: start, dueDate: due, priority: 'HIGH' }), {
      progress: 100,
    });
    expect(change).toMatchObject({
      status: 'DONE',
      semaphore: 'GREEN',
      actualCompletionDate: now,
      actualDurationHours: 24,
      timeToCompletionHours: 52,
      completionDelayDays: -1, // one day early
      priorityAtCompletion: 'HIGH',
    });
    expect(events.completed).toBe(true);
  });

  it('status DONE forces 100% and refuses a contradicting progress', () => {
    expect(derive(snapshot({ status: 'IN_PROGRESS', progress: 50 }), { status: 'DONE' }).change.progress).toBe(100);
    expectValidation(() => derive(snapshot(), { status: 'DONE', progress: 50 }), 'progress');
  });

  it('refuses 100% on a task explicitly kept open', () => {
    expectValidation(() => derive(snapshot(), { status: 'IN_PROGRESS', progress: 100 }), 'status');
  });

  it('lowering progress reopens a DONE task and clears completion metrics', () => {
    const done = derive(snapshot({ status: 'IN_PROGRESS', progress: 75, actualStartDate: created }), { progress: 100 }).change;
    const { change, events } = derive(snapshot({ ...done }), { progress: 50 });
    expect(change).toMatchObject({ status: 'IN_PROGRESS', progress: 50, semaphore: 'RED', actualCompletionDate: null, actualDurationHours: null });
    expect(events.reopened).toBe(true);
  });

  it('reopening by status alone moves progress off 100', () => {
    const done = snapshot({ status: 'DONE', progress: 100, actualCompletionDate: created });
    expect(derive(done, { status: 'IN_PROGRESS' }).change.progress).toBe(75);
    expect(derive(done, { status: 'TODO' }).change.progress).toBe(0);
  });

  it('editing a DONE task keeps its completion snapshot', () => {
    const doneAt = new Date('2026-09-29T00:00:00Z');
    const cur = snapshot({
      status: 'DONE',
      progress: 100,
      actualCompletionDate: doneAt,
      actualDurationHours: 5,
      timeToCompletionHours: 16,
      completionDelayDays: 0.5,
      priorityAtCompletion: 'LOW',
    });
    const { change } = derive(cur, { priority: 'URGENT' });
    expect(change).toMatchObject({ actualCompletionDate: doneAt, actualDurationHours: 5, completionDelayDays: 0.5, priorityAtCompletion: 'LOW' });
  });
});

describe('blocking', () => {
  it('requires a reason to block', () => {
    expectValidation(() => derive(snapshot(), { status: 'BLOCKED' }), 'blockReason');
    expectValidation(() => derive(snapshot(), { status: 'BLOCKED', blockReason: '   ' }), 'blockReason');
  });

  it('records who blocked, since when, and why', () => {
    const { change, events } = derive(snapshot({ status: 'IN_PROGRESS', progress: 50 }), {
      status: 'BLOCKED',
      blockReason: '  Esperando aprobación de finanzas ',
    });
    expect(change).toMatchObject({
      status: 'BLOCKED',
      blockReason: 'Esperando aprobación de finanzas',
      blockedSince: now,
      blockedByUserId: 'user-1',
      wasBlocked: true,
    });
    expect(events.blocked).toBe(true);
  });

  it('keeps blockedSince when only the reason changes, and refuses clearing it', () => {
    const since = new Date('2026-09-29T00:00:00Z');
    const blocked = snapshot({ status: 'BLOCKED', blockReason: 'A', blockedSince: since, blockedByUserId: 'u-0' });
    const { change, events } = derive(blocked, { blockReason: 'B' });
    expect(change).toMatchObject({ blockReason: 'B', blockedSince: since, blockedByUserId: 'u-0' });
    expect(events.blocked).toBe(false);
    expectValidation(() => derive(blocked, { blockReason: null }), 'blockReason');
  });

  it('unblocking clears the block fields but remembers the task was blocked', () => {
    const blocked = snapshot({ status: 'BLOCKED', progress: 50, blockReason: 'A', blockedSince: created, blockedByUserId: 'u-0' });
    const { change, events } = derive(blocked, { status: 'IN_PROGRESS' });
    expect(change).toMatchObject({ status: 'IN_PROGRESS', blockReason: null, blockedSince: null, blockedByUserId: null });
    expect(change.wasBlocked).toBeUndefined(); // not reset: the DB keeps true
    expect(events.unblocked).toBe(true);
  });

  it('refuses a block reason on a task that is not blocked', () => {
    expectValidation(() => derive(snapshot(), { blockReason: 'why?' }), 'blockReason');
  });

  it('a blocked task may be at 100% without completing', () => {
    const { change } = derive(snapshot({ status: 'BLOCKED', progress: 75, blockReason: 'A', blockedSince: created }), { progress: 100 });
    expect(change.status).toBe('BLOCKED');
  });
});

describe('KPI', () => {
  it('stamps kpiRecordedAt when the actual is written and clears it when removed', () => {
    expect(derive(snapshot(), { kpiActual: '48 leads' }).change.kpiRecordedAt).toEqual(now);
    expect(derive(snapshot({ kpiActual: '48 leads' }), { kpiActual: null }).change.kpiRecordedAt).toBeNull();
    expect(derive(snapshot({ kpiActual: '48 leads' }), { kpiActual: '48 leads' }).change.kpiRecordedAt).toBeUndefined();
  });
});
