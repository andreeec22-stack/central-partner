import type { Task } from '@prisma/client';
import { notFound } from '../../lib/errors';
import { departmentFilter, type DepartmentScope } from '../../lib/permissions';
import type { Tx } from '../../lib/prisma';
import type { AuthUser } from '../../types';

export async function findVisibleTask(db: Tx, user: AuthUser, scope: DepartmentScope, id: string): Promise<Task> {
  const task = await db.task.findFirst({
    where: { id, workspaceId: user.workspaceId, deletedAt: null, departmentId: departmentFilter(scope) },
  });
  // 404 rather than 403: tasks outside your scope don't exist for you.
  if (!task) throw notFound('Task');
  return task;
}
