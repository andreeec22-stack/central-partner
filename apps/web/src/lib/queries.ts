import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { DashboardData, Department, Paginated, Priority, Task, TaskStatus, UserSummary } from './types';
import { toast } from '../stores/toast';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 4xx won't fix itself on retry.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

export const keys = {
  tasks: ['tasks'] as const,
  taskList: (filters: TaskFilters) => ['tasks', 'list', filters] as const,
  departments: ['departments'] as const,
  users: (departmentId?: string) => ['users', departmentId ?? 'all'] as const,
  dashboard: (departmentId?: string) => ['dashboard', departmentId ?? 'all'] as const,
};

// ─── Tasks ──────────────────────────────────────────────────────────────────

export interface TaskFilters {
  week?: 'last' | 'this' | 'next';
  departmentId?: string;
  status?: TaskStatus[];
  assignedTo?: 'me' | 'unassigned' | string;
  search?: string;
  sortBy?: 'createdAt' | 'dueDate' | 'priority' | 'progress' | 'title';
  sortOrder?: 'asc' | 'desc';
  page?: number;
}

export function useTasks(filters: TaskFilters) {
  return useQuery({
    queryKey: keys.taskList(filters),
    queryFn: ({ signal }) =>
      api<Paginated<Task>>('/tasks', {
        signal,
        query: {
          week: filters.week,
          departmentId: filters.departmentId,
          status: filters.status?.join(','),
          assignedTo: filters.assignedTo,
          search: filters.search,
          sortBy: filters.sortBy,
          sortOrder: filters.sortOrder,
          page: filters.page,
          limit: 50,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  departmentId?: string;
  assignedTo?: string | null;
  priority?: Priority;
  dueDate?: string | null;
  kpiTarget?: string | null;
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api<{ task: Task }>('/tasks', { method: 'POST', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export type TaskPatch = Partial<{
  title: string;
  status: TaskStatus;
  progress: number;
  priority: Priority;
  blockReason: string | null;
  kpiActual: string | null;
  assignedTo: string | null;
  dueDate: string | null;
}>;

function semaphoreFor(progress: number): Task['semaphore'] {
  return progress >= 90 ? 'GREEN' : progress >= 70 ? 'YELLOW' : 'RED';
}

// Optimistic: the row changes instantly; the server's answer (which may derive
// more, e.g. status DONE at 100%) replaces it, and errors roll back.
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TaskPatch }) =>
      api<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: patch }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.tasks });
      const snapshots = qc.getQueriesData<Paginated<Task>>({ queryKey: ['tasks', 'list'] });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        qc.setQueryData<Paginated<Task>>(key, {
          ...data,
          data: data.data.map((t) =>
            t.id === id
              ? {
                  ...t,
                  ...(patch.progress !== undefined ? { progress: patch.progress, semaphore: semaphoreFor(patch.progress) } : {}),
                  ...(patch.status ? { status: patch.status } : {}),
                  ...(patch.priority ? { priority: patch.priority } : {}),
                  ...(patch.blockReason !== undefined ? { blockReason: patch.blockReason } : {}),
                  ...(patch.kpiActual !== undefined ? { kpiActual: patch.kpiActual } : {}),
                }
              : t,
          ),
        });
      }
      return { snapshots };
    },
    onError: (error, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
      toast.error(error instanceof ApiError ? error.message : 'No se pudo guardar el cambio');
    },
    onSuccess: ({ task }) => {
      for (const [key, data] of qc.getQueriesData<Paginated<Task>>({ queryKey: ['tasks', 'list'] })) {
        if (data) qc.setQueryData<Paginated<Task>>(key, { ...data, data: data.data.map((t) => (t.id === task.id ? task : t)) });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ─── Reference data ─────────────────────────────────────────────────────────

export function useDepartments() {
  return useQuery({
    queryKey: keys.departments,
    queryFn: ({ signal }) => api<{ data: Department[] }>('/departments', { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useUsers(departmentId?: string, enabled = true) {
  return useQuery({
    queryKey: keys.users(departmentId),
    queryFn: ({ signal }) =>
      api<Paginated<UserSummary>>('/users', { signal, query: { departmentId, limit: 100 } }).then((r) => r.data),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useDashboard(departmentId?: string) {
  return useQuery({
    queryKey: keys.dashboard(departmentId),
    queryFn: ({ signal }) => api<DashboardData>('/dashboard', { signal, query: { departmentId } }),
  });
}
