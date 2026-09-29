import type { Priority, Role, Semaphore, TaskStatus } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'Pendiente',
  IN_PROGRESS: 'En progreso',
  BLOCKED: 'Bloqueada',
  DONE: 'Completada',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  LOW: 'Baja',
  MEDIUM: 'Media',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Director',
  JEFE_AREA: 'Jefe de área',
  USER: 'Colaborador',
  VIEWER: 'Lector',
};

export const SEMAPHORE_LABEL: Record<Semaphore, string> = {
  GREEN: 'En meta',
  YELLOW: 'En riesgo',
  RED: 'Atrasada',
};

export const ACTIVITY_LABEL: Record<string, string> = {
  TASK_CREATED: 'creó',
  TASK_UPDATED: 'actualizó',
  TASK_BLOCKED: 'bloqueó',
  TASK_UNBLOCKED: 'desbloqueó',
  TASK_COMPLETED: 'completó',
  TASK_DELETED: 'eliminó',
  TASK_DEPENDENCY_ADDED: 'añadió una dependencia a',
  TASK_DEPENDENCY_REMOVED: 'quitó una dependencia de',
  COMMENT_ADDED: 'comentó en',
  COMMENT_EDITED: 'editó un comentario en',
  COMMENT_DELETED: 'borró un comentario en',
  FILE_UPLOADED: 'adjuntó un archivo a',
  FILE_DELETED: 'eliminó un archivo de',
};

// Field names in activity diffs.
export const FIELD_LABEL: Record<string, string> = {
  title: 'título',
  description: 'descripción',
  status: 'estado',
  priority: 'prioridad',
  progress: 'progreso',
  assignedToId: 'responsable',
  departmentId: 'departamento',
  dueDate: 'fecha límite',
  kpiTarget: 'meta KPI',
  kpiActual: 'resultado KPI',
  blockReason: 'motivo de bloqueo',
  parentTaskId: 'tarea padre',
};

export const PROGRESS_STEPS = [0, 25, 50, 75, 100] as const;
