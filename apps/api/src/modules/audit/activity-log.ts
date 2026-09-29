import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';

// Activity actions are stable strings so the audit export stays readable.
export const ActivityAction = {
  WORKSPACE_CREATED: 'WORKSPACE_CREATED',
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGGED_IN: 'USER_LOGGED_IN',
  USER_LOGGED_OUT: 'USER_LOGGED_OUT',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
} as const;
export type ActivityAction = (typeof ActivityAction)[keyof typeof ActivityAction];

export type FieldChanges = Record<string, { old: unknown; new: unknown }>;

export interface ActivityEntry {
  workspaceId: string;
  userId: string | null;
  action: ActivityAction;
  entityType: string;
  entityId?: string | null;
  changes?: FieldChanges;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

// Pass the transaction client when the audited change is itself transactional,
// so the log row commits (or rolls back) with the change.
export async function logActivity(entry: ActivityEntry, db: Tx = prisma) {
  await db.activityLog.create({
    data: {
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      changes: (entry.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: entry.ipAddress,
    },
  });
}

// Builds { field: { old, new } } for the fields that actually changed.
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): FieldChanges {
  const changes: FieldChanges = {};
  for (const key of Object.keys(after)) {
    const oldValue = before[key];
    const newValue = after[key];
    if (newValue === undefined) continue;
    const same =
      oldValue instanceof Date && newValue instanceof Date
        ? oldValue.getTime() === newValue.getTime()
        : JSON.stringify(oldValue) === JSON.stringify(newValue);
    if (!same) changes[key] = { old: oldValue ?? null, new: newValue ?? null };
  }
  return changes;
}
