import type { Task, User } from './types';

// Mirrors the API rules so the UI only offers what will succeed. The API still
// enforces everything; this just avoids showing controls that would 403.

export function canCreateTasks(user: User): boolean {
  return user.role === 'ADMIN' || (user.role === 'JEFE_AREA' && user.canCreateTasks);
}

export function canEditTask(user: User, task: Pick<Task, 'departmentId' | 'assignedToId' | 'createdById'>): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VIEWER') return false;
  if (user.role === 'JEFE_AREA' && user.departmentId === task.departmentId) return true;
  return task.assignedToId === user.id || task.createdById === user.id;
}

// Reassigning, rescheduling and setting the KPI target are the area head's call.
export function isManagerOf(user: User, task: Pick<Task, 'departmentId'>): boolean {
  return user.role === 'ADMIN' || (user.role === 'JEFE_AREA' && user.departmentId === task.departmentId);
}

export function canDeleteTask(user: User, task: Pick<Task, 'departmentId' | 'createdById'>): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'JEFE_AREA' && user.departmentId === task.departmentId) return true;
  return user.role !== 'VIEWER' && task.createdById === user.id;
}
