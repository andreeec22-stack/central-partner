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
  DEPARTMENT_CREATED: 'DEPARTMENT_CREATED',
  DEPARTMENT_UPDATED: 'DEPARTMENT_UPDATED',
  DEPARTMENT_DELETED: 'DEPARTMENT_DELETED',
  USER_INVITED: 'USER_INVITED',
  INVITATION_ACCEPTED: 'INVITATION_ACCEPTED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_RESTORED: 'USER_RESTORED',
  NOTIFICATION_PREFERENCES_UPDATED: 'NOTIFICATION_PREFERENCES_UPDATED',
  TASK_CREATED: 'TASK_CREATED',
  TASK_UPDATED: 'TASK_UPDATED',
  TASK_BLOCKED: 'TASK_BLOCKED',
  TASK_UNBLOCKED: 'TASK_UNBLOCKED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_DELETED: 'TASK_DELETED',
  TASK_DEPENDENCY_ADDED: 'TASK_DEPENDENCY_ADDED',
  TASK_DEPENDENCY_REMOVED: 'TASK_DEPENDENCY_REMOVED',
  TASKS_IMPORTED: 'TASKS_IMPORTED',
  COMMENT_ADDED: 'COMMENT_ADDED',
  COMMENT_EDITED: 'COMMENT_EDITED',
  COMMENT_DELETED: 'COMMENT_DELETED',
  FILE_UPLOADED: 'FILE_UPLOADED',
  FILE_DELETED: 'FILE_DELETED',
  EXCEL_IMPORT_UPLOADED: 'EXCEL_IMPORT_UPLOADED',
  EXCEL_IMPORT_CONFIRMED: 'EXCEL_IMPORT_CONFIRMED',
  BRANDING_UPDATED: 'BRANDING_UPDATED',
  BRANDING_LOGO_UPDATED: 'BRANDING_LOGO_UPDATED',
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
