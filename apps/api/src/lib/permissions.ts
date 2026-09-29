import type { Prisma, Role } from '@prisma/client';
import type { AuthUser } from '../types';
import { cached, cacheKeys, invalidate } from './cache';
import { prisma } from './prisma';

// Which departments a user can SEE. Editing is narrower (see canEditTask).
//   ADMIN      → every department
//   JEFE_AREA  → own department + departments granted in DepartmentVisibility (read-only)
//   USER/VIEWER→ own department only
export type DepartmentScope = { all: true } | { all: false; departmentIds: string[] };

type ScopeUser = Pick<AuthUser, 'id' | 'role' | 'departmentId' | 'workspaceId'>;
type CreatorUser = ScopeUser & Pick<AuthUser, 'canCreateTasks'>;

const PERMISSION_TTL_SECONDS = 60 * 60;

export async function departmentScope(user: ScopeUser): Promise<DepartmentScope> {
  if (user.role === 'ADMIN') return { all: true };
  const own = user.departmentId ? [user.departmentId] : [];
  if (user.role !== 'JEFE_AREA') return { all: false, departmentIds: own };

  const granted = await cached(cacheKeys.departmentScope(user.id), PERMISSION_TTL_SECONDS, async () => {
    const row = await prisma.departmentVisibility.findUnique({
      where: { jefeAreaId: user.id },
      select: { visibleDepartmentIds: true, workspaceId: true },
    });
    return row && row.workspaceId === user.workspaceId ? row.visibleDepartmentIds : [];
  });
  return { all: false, departmentIds: [...new Set([...own, ...granted])] };
}

export function invalidatePermissions(...userIds: string[]) {
  return invalidate(...userIds.map(cacheKeys.departmentScope));
}

export function canSeeDepartment(scope: DepartmentScope, departmentId: string): boolean {
  return scope.all || scope.departmentIds.includes(departmentId);
}

// Prisma filter restricting a departmentId column to the scope.
export function departmentFilter(scope: DepartmentScope): Prisma.StringFilter | undefined {
  return scope.all ? undefined : { in: scope.departmentIds };
}

export const isReadOnlyRole = (role: Role) => role === 'VIEWER';
export const isManager = (role: Role) => role === 'ADMIN' || role === 'JEFE_AREA';

interface TaskRef {
  departmentId: string;
  assignedToId: string | null;
  createdById: string;
}

// Who may create tasks at all: ADMIN always; JEFE_AREA only with the
// director's canCreateTasks grant; USER and VIEWER never.
export function canCreateTasks(user: Pick<AuthUser, 'role' | 'canCreateTasks'>): boolean {
  if (user.role === 'ADMIN') return true;
  return user.role === 'JEFE_AREA' && user.canCreateTasks;
}

// ...and where: ADMIN anywhere, a granted JEFE_AREA in their own department.
export function canCreateTaskIn(user: CreatorUser, departmentId: string): boolean {
  if (!canCreateTasks(user)) return false;
  return user.role === 'ADMIN' || user.departmentId === departmentId;
}

// PATCH permission: Assignee | JEFE_AREA (own department) | ADMIN. The task's
// creator also keeps edit rights over it. Visibility grants never allow edits.
export function canEditTask(user: ScopeUser, task: TaskRef): boolean {
  if (user.role === 'ADMIN') return true;
  if (isReadOnlyRole(user.role)) return false;
  if (user.role === 'JEFE_AREA' && user.departmentId === task.departmentId) return true;
  return task.assignedToId === user.id || task.createdById === user.id;
}

// DELETE permission: Creator | JEFE_AREA (own department) | ADMIN.
export function canDeleteTask(user: ScopeUser, task: TaskRef): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'JEFE_AREA' && user.departmentId === task.departmentId) return true;
  return !isReadOnlyRole(user.role) && task.createdById === user.id;
}
