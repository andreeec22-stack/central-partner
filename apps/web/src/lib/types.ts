// Shapes returned by the API (/api/v1). Kept hand-written and minimal: only
// the fields the UI reads.

export type Role = 'ADMIN' | 'JEFE_AREA' | 'USER' | 'VIEWER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type Semaphore = 'GREEN' | 'YELLOW' | 'RED';

export interface User {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: Role;
  canCreateTasks: boolean;
  departmentId: string | null;
  phoneNumber?: string | null;
  timezone: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export interface Department {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  headId: string | null;
  usersCount: number;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  departmentId: string | null;
}

export interface Task {
  id: string;
  workspaceId: string;
  departmentId: string;
  assignedToId: string | null;
  createdById: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  progress: number;
  semaphore: Semaphore;
  dueDate: string | null;
  blockReason: string | null;
  blockedSince: string | null;
  kpiTarget: string | null;
  kpiActual: string | null;
  sourceType: 'MANUAL' | 'EXCEL_IMPORT';
  createdAt: string;
  updatedAt: string;
  assignedTo: { id: string; displayName: string } | null;
  createdBy: { id: string; displayName: string };
  department: { id: string; name: string; color: string | null };
  counts: { subTasks: number; comments: number; files: number };
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface DashboardData {
  summary: { totalTasks: number; todoCount: number; inProgressCount: number; blockedCount: number; completedCount: number };
  semaphore: Record<Semaphore, number>;
  byDepartment: {
    id: string;
    name: string;
    color: string | null;
    totalTasks: number;
    status: Record<TaskStatus, number>;
    semaphore: Record<Semaphore, number>;
    averageProgress: number | null;
  }[];
  recentActivity: {
    id: string;
    action: string;
    createdAt: string;
    actor: { id: string; displayName: string } | null;
    task: { id: string; title: string; departmentId: string };
    changes: Record<string, { old: unknown; new: unknown }> | null;
  }[];
  generatedAt: string;
}

export interface AuthPayload {
  user: User;
  workspace: Workspace;
  accessToken: string;
  expiresIn: number;
}
