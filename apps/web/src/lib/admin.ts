import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '../stores/toast';
import { api, ApiError, download, saveBlob } from './api';
import type { AreaSemaphore, Role, WeekSummary } from './types';

// Data and actions of the back office (Settings, Semanas, Auditoría). ADMIN only;
// the API enforces it again on every call.

export const adminKeys = {
  users: ['admin', 'users'] as const,
  invitations: ['admin', 'invitations'] as const,
  permissions: ['admin', 'permissions'] as const,
  workspace: ['workspace'] as const,
  weeks: ['admin', 'weeks'] as const,
  audit: ['admin', 'audit'] as const,
};

const failed = (fallback: string) => (e: unknown) => toast.error(e instanceof ApiError ? e.message : fallback);

// ─── Users ──────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  canCreateTasks: boolean;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  timezone: string;
  phoneNumber?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface UserFilters {
  search?: string;
  role?: Role;
  status: 'active' | 'deleted';
  page: number;
}

export const USERS_PAGE_SIZE = 50;

export function useAdminUsers(f: UserFilters) {
  return useQuery({
    queryKey: [...adminKeys.users, f],
    queryFn: ({ signal }) =>
      api<{ data: AdminUser[]; total: number; page: number; limit: number }>('/users', {
        signal,
        query: { search: f.search, role: f.role, status: f.status, page: f.page, limit: USERS_PAGE_SIZE },
      }),
    placeholderData: keepPreviousData,
  });
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  canCreateTasks: boolean;
  departmentId: string | null;
  expiresAt: string;
  createdAt: string;
}

export function useInvitations() {
  return useQuery({
    queryKey: adminKeys.invitations,
    queryFn: ({ signal }) => api<{ data: Invitation[] }>('/users/invitations', { signal }).then((r) => r.data),
  });
}

export interface InviteInput {
  email: string;
  role: Role;
  departmentId: string | null;
  canCreateTasks?: boolean;
  phoneNumber?: string | null;
}

function useAdminMutation<V, R>(fn: (v: V) => Promise<R>, invalidate: readonly (readonly string[])[], error: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    onError: failed(error),
  });
}

export function useInviteUser() {
  // Errors are shown inside the form (field-level), not as a toast.
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteInput) => api<{ invitationId: string; inviteUrl: string; expiresAt: string }>('/users', { method: 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.invitations }),
  });
}

export interface UserPatch {
  displayName?: string;
  role?: Role;
  departmentId?: string | null;
  canCreateTasks?: boolean;
  phoneNumber?: string | null;
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserPatch }) => api<{ user: AdminUser }>(`/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.users });
      void qc.invalidateQueries({ queryKey: adminKeys.permissions });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export const useDeactivateUser = () =>
  useAdminMutation((id: string) => api(`/users/${id}`, { method: 'DELETE' }), [adminKeys.users, ['users']], 'No se pudo desactivar');
export const useRestoreUser = () =>
  useAdminMutation((id: string) => api(`/users/${id}/restore`, { method: 'POST' }), [adminKeys.users, ['users']], 'No se pudo reactivar');
export const useRevokeInvitation = () =>
  useAdminMutation((id: string) => api(`/users/invitations/${id}`, { method: 'DELETE' }), [adminKeys.invitations], 'No se pudo anular');

// ─── Departments ────────────────────────────────────────────────────────────

export interface DepartmentInput {
  name: string;
  color: string | null;
  description: string | null;
  headId: string | null;
}

export function useSaveDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: DepartmentInput }) =>
      id ? api(`/departments/${id}`, { method: 'PATCH', body: input }) : api('/departments', { method: 'POST', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// The page explains the "still has tasks" case itself; other errors get a toast.
export function useDeactivateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/departments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => {
      if (!(e instanceof ApiError && e.code === 'DEPARTMENT_NOT_EMPTY')) failed('No se pudo desactivar el departamento')(e);
    },
  });
}

// ─── Permissions ────────────────────────────────────────────────────────────

export interface RolePermissions {
  role: Role;
  label: string;
  description: string;
  permissions: { key: string; label: string; granted: boolean | 'configurable' }[];
}

export interface JefeSettings {
  id: string;
  displayName: string;
  email: string;
  departmentId: string | null;
  departmentName: string | null;
  canCreateTasks: boolean;
  visibleDepartmentIds: string[];
}

export function usePermissions() {
  return useQuery({
    queryKey: adminKeys.permissions,
    queryFn: ({ signal }) => api<{ roles: RolePermissions[]; jefes: JefeSettings[] }>('/permissions', { signal }),
  });
}

export function useUpdateJefe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; canCreateTasks?: boolean; visibleDepartmentIds?: string[] }) =>
      api<{ jefes: JefeSettings[] }>('/permissions/JEFE_AREA', { method: 'PATCH', body: input }),
    onSuccess: (data) => {
      qc.setQueryData<{ roles: RolePermissions[]; jefes: JefeSettings[] }>(adminKeys.permissions, (old) => (old ? { ...old, jefes: data.jefes } : old));
      void qc.invalidateQueries({ queryKey: adminKeys.users });
    },
    onError: failed('No se pudieron guardar los permisos'),
  });
}

// ─── Workspace ──────────────────────────────────────────────────────────────

export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string;
  contactEmail: string | null;
  timezone: string;
  primaryColor: string;
  logoUrl: string | null;
  updatedAt: string;
}

export function useWorkspaceConfig() {
  return useQuery({
    queryKey: adminKeys.workspace,
    queryFn: ({ signal }) => api<{ workspace: WorkspaceConfig }>('/workspace', { signal }).then((r) => r.workspace),
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<WorkspaceConfig, 'name' | 'contactEmail' | 'timezone' | 'primaryColor'>>) =>
      api<{ workspace: WorkspaceConfig }>('/workspace', { method: 'PATCH', body: patch }).then((r) => r.workspace),
    onSuccess: (ws) => {
      qc.setQueryData(adminKeys.workspace, ws);
      void qc.invalidateQueries({ queryKey: ['branding'] });
      // The timezone moves weeks and "today".
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ─── Weeks ──────────────────────────────────────────────────────────────────

export interface WeekRow extends WeekSummary {
  archivedAt: string | null;
  createdAt: string;
}

export interface ArchivedWeek extends WeekRow {
  archivedBy: { id: string; displayName: string } | null;
  index: number | null;
  semaphore: AreaSemaphore | null;
  tasks: { total: number; done: number; overdue: number } | null;
}

export interface ClosureReport {
  week: WeekRow;
  departments: {
    departmentId: string;
    departmentName: string;
    tasksWithoutProgress: number;
    kpisMissing: number;
    functionsUnmarked: number;
    noKpis: boolean;
    noFunctions: boolean;
    complete: boolean;
  }[];
  incompleteCount: number;
  closableAt: string;
  canClose: boolean;
}

export interface CloseResult {
  week: WeekRow;
  nextWeek: WeekRow;
  carriedTasks: number;
  overall: { index: number | null };
  incompleteAreas: number;
}

export function useWeeksOverview() {
  return useQuery({
    queryKey: [...adminKeys.weeks, 'overview'],
    queryFn: ({ signal }) => api<{ current: WeekRow; data: WeekRow[] }>('/weeks', { signal, query: { limit: 26 } }),
  });
}

export function useArchivedWeeks(page: number) {
  return useQuery({
    queryKey: [...adminKeys.weeks, 'archived', page],
    queryFn: ({ signal }) =>
      api<{ data: ArchivedWeek[]; total: number; page: number; limit: number }>('/weeks/archived', { signal, query: { page, limit: 20 } }),
    placeholderData: keepPreviousData,
  });
}

export function useClosureCheck(weekId: string | null) {
  return useQuery({
    queryKey: [...adminKeys.weeks, 'closure', weekId],
    queryFn: ({ signal }) => api<ClosureReport>(`/weeks/${weekId}/closure-check`, { signal }),
    enabled: !!weekId,
  });
}

export function useCloseWeek() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ weekId, force }: { weekId: string; force: boolean }) =>
      api<CloseResult>(`/weeks/${weekId}/close`, { method: 'POST', body: { force } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.weeks });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export async function downloadWeek(weekId: string, weekNumber: number) {
  try {
    const { blob, filename } = await download(`/weeks/${weekId}/export`, { method: 'POST', fallbackName: `Semana-${weekNumber}.xlsx` });
    saveBlob(blob, filename);
  } catch (e) {
    failed('No se pudo descargar la semana')(e);
  }
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actionLabel: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  user: { id: string; name: string; email: string } | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface AuditFilters {
  search?: string;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
}

export const AUDIT_PAGE_SIZE = 100;

export function useAuditLogs(f: AuditFilters) {
  return useQuery({
    queryKey: [...adminKeys.audit, f],
    queryFn: ({ signal }) =>
      api<{ data: AuditEntry[]; total: number; page: number; limit: number }>('/audit-logs', {
        signal,
        query: { ...f, limit: AUDIT_PAGE_SIZE },
      }),
    placeholderData: keepPreviousData,
  });
}

export async function downloadAudit(format: 'csv' | 'xlsx', f: Omit<AuditFilters, 'page'>) {
  try {
    const { blob, filename } = await download('/audit-logs/export', { query: { ...f, format }, fallbackName: `auditoria.${format}` });
    saveBlob(blob, filename);
  } catch (e) {
    failed('No se pudo exportar la auditoría')(e);
  }
}
