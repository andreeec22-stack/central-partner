import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, uploadFile } from './api';
import type {
  Branding,
  BrandColors,
  Comment,
  Department,
  ImportConfirmResult,
  ImportSummary,
  ImportTaskStatus,
  ImportUploadResult,
  Mentionable,
  Paginated,
  Priority,
  Task,
  TaskDetail,
  TaskFile,
  TaskStatus,
  HistoryWeek,
  UserSummary,
  WeekDashboard,
} from './types';
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
  task: (id: string) => ['task', id] as const,
  mentionable: (id: string) => ['task', id, 'mentionable'] as const,
  branding: (workspaceId: string) => ['branding', workspaceId] as const,
  imports: ['imports'] as const,
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
  description: string | null;
  kpiTarget: string | null;
  status: TaskStatus;
  progress: number;
  priority: Priority;
  blockReason: string | null;
  kpiActual: string | null;
  assignedTo: string | null;
  dueDate: string | null;
}>;

// The semaphore depends on the task's day; optimistically only 100% is certain
// (green). Anything else keeps its color until the server answers.
function optimisticSemaphore(task: Task, progress: number): Task['semaphore'] {
  return progress >= 100 ? 'GREEN' : task.semaphore === 'GREEN' ? 'GRAY' : task.semaphore;
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
                  ...(patch.progress !== undefined ? { progress: patch.progress, semaphore: optimisticSemaphore(t, patch.progress) } : {}),
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
    onSettled: (_data, _error, { id }) => {
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: keys.task(id) });
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

// "current" or a week id. Kept fresh by the socket (task/KPI/function/week events).
export function useWeekDashboard(weekRef = 'current', departmentId?: string) {
  return useQuery({
    queryKey: keys.dashboard(`${weekRef}:${departmentId ?? 'all'}`),
    queryFn: ({ signal }) => api<WeekDashboard>(`/dashboard/week/${weekRef}`, { signal, query: { departmentId } }),
    // Changing a filter keeps the previous numbers (dimmed) instead of flashing skeletons.
    placeholderData: keepPreviousData,
  });
}

// Last 3 closed weeks + the current one, oldest first. Past weeks are frozen,
// so this is cached longer; socket events still invalidate it.
export function useWeekHistory(departmentId?: string) {
  return useQuery<HistoryWeek[]>({
    queryKey: ['dashboard', 'history', departmentId ?? 'all'] as const,
    queryFn: ({ signal }) =>
      api<{ weeks: HistoryWeek[] }>('/dashboard/week/history', { signal, query: { limit: 3, departmentId } }).then((r) => r.weeks),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Task detail: comments & files ──────────────────────────────────────────

export function useTaskDetail(id: string | null) {
  return useQuery({
    queryKey: keys.task(id ?? 'none'),
    queryFn: ({ signal }) => api<TaskDetail>(`/tasks/${id}`, { signal }),
    enabled: !!id,
    // Signed file URLs expire; a panel left open refreshes them well before.
    staleTime: 60_000,
  });
}

export function useMentionable(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.mentionable(taskId),
    queryFn: ({ signal }) => api<{ data: Mentionable[] }>(`/tasks/${taskId}/mentionable`, { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
    enabled,
  });
}

function useTaskMutation<TVars, TResult>(taskId: string, fn: (vars: TVars) => Promise<TResult>, error: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.task(taskId), exact: true });
      void qc.invalidateQueries({ queryKey: ['tasks', 'list'] }); // comment/file counts
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : error),
  });
}

export function useAddComment(taskId: string) {
  return useTaskMutation(
    taskId,
    (content: string) => api<{ comment: Comment }>(`/tasks/${taskId}/comments`, { method: 'POST', body: { content } }),
    'No se pudo publicar el comentario',
  );
}

export function useEditComment(taskId: string) {
  return useTaskMutation(
    taskId,
    ({ id, content }: { id: string; content: string }) =>
      api<{ comment: Comment }>(`/tasks/${taskId}/comments/${id}`, { method: 'PATCH', body: { content } }),
    'No se pudo editar el comentario',
  );
}

export function useDeleteComment(taskId: string) {
  return useTaskMutation(taskId, (id: string) => api(`/tasks/${taskId}/comments/${id}`, { method: 'DELETE' }), 'No se pudo borrar el comentario');
}

export function useUploadTaskFile(taskId: string) {
  return useTaskMutation(taskId, (file: File) => uploadFile<{ file: TaskFile }>(`/tasks/${taskId}/files`, file), 'No se pudo subir el archivo');
}

export function useDeleteTaskFile(taskId: string) {
  return useTaskMutation(taskId, (id: string) => api(`/tasks/${taskId}/files/${id}`, { method: 'DELETE' }), 'No se pudo borrar el archivo');
}

// A fresh signed URL at click time, so a panel open for hours still downloads.
export function fetchDownloadUrl(taskId: string, fileId: string) {
  return api<{ url: string }>(`/tasks/${taskId}/files/${fileId}/download`, { query: { format: 'json' } }).then((r) => r.url);
}

// ─── Branding ───────────────────────────────────────────────────────────────

export function useBranding(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.branding(workspaceId ?? 'none'),
    queryFn: ({ signal }) => api<{ branding: Branding }>(`/workspaces/${workspaceId}/branding`, { signal }).then((r) => r.branding),
    enabled: !!workspaceId,
    staleTime: 10 * 60_000,
  });
}

export interface BrandingPatch {
  workspaceName?: string;
  tagline?: string | null;
  colors?: Partial<BrandColors>;
}

export function useUpdateBranding(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: BrandingPatch) =>
      api<{ branding: Branding }>(`/workspaces/${workspaceId}/branding`, { method: 'PATCH', body: patch }).then((r) => r.branding),
    onSuccess: (branding) => qc.setQueryData(keys.branding(workspaceId), branding),
  });
}

export function useUploadLogo(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      uploadFile<{ branding: Branding }>(`/workspaces/${workspaceId}/branding/logo/upload`, file).then((r) => r.branding),
    onSuccess: (branding) => qc.setQueryData(keys.branding(workspaceId), branding),
  });
}

export function useRemoveLogo(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ branding: Branding }>(`/workspaces/${workspaceId}/branding/logo`, { method: 'DELETE' }).then((r) => r.branding),
    onSuccess: (branding) => qc.setQueryData(keys.branding(workspaceId), branding),
  });
}

// ─── Excel import ───────────────────────────────────────────────────────────

export function useImports() {
  return useQuery({
    queryKey: keys.imports,
    queryFn: ({ signal }) => api<Paginated<ImportSummary>>('/excel-imports', { signal, query: { limit: 20 } }),
  });
}

export function useUploadImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadFile<ImportUploadResult>('/excel-imports/upload', file),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.imports }),
  });
}

export interface ImportMapping {
  rowIndex: number;
  title: string;
  departmentId: string;
  assignedToId?: string | null;
  priority?: Priority;
  status?: ImportTaskStatus;
  kpiTarget?: string | null;
  description?: string | null;
  dueDate?: string | null;
}

export function useConfirmImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ importId, taskMappings }: { importId: string; taskMappings: ImportMapping[] }) =>
      api<ImportConfirmResult>(`/excel-imports/${importId}/confirm`, { method: 'POST', body: { taskMappings } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.imports });
      void qc.invalidateQueries({ queryKey: keys.tasks });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDiscardImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (importId: string) => api(`/excel-imports/${importId}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.imports }),
  });
}
