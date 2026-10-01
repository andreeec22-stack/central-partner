import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '../stores/toast';
import { api, ApiError } from './api';
import type { PerformanceRating } from './performance';

// OKRs (company → area → person) and the performance scorecard. Scores and
// progress are 0–100; null = no data. The API decides who sees and edits what;
// each OKR carries `permissions` for the viewer.

export type OkrLevel = 'COMPANY' | 'AREA' | 'PERSON';
export type OkrStatus = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'COMPLETED';

export interface KeyResult {
  id: string;
  title: string;
  unit: string | null;
  startValue: number;
  target: number;
  current: number;
  progress: number;
}

export interface Okr {
  id: string;
  period: string;
  level: OkrLevel;
  parentId: string | null;
  department: { id: string; name: string; color: string | null } | null;
  owner: { id: string; displayName: string } | null;
  title: string;
  description: string | null;
  deadline: string | null;
  progress: number;
  expectedProgress: number;
  status: OkrStatus;
  childrenCount: number;
  lastCheckInAt: string | null;
  keyResults: KeyResult[];
  permissions: { canEdit: boolean; canCheckIn: boolean };
}

export type OkrNode = Okr & { children: OkrNode[] };

export interface OkrTree {
  period: string;
  summary: Record<OkrStatus, number> & { total: number };
  roots: OkrNode[];
}

export interface CheckIn {
  id: string;
  progress: number;
  values: { keyResultId: string; previous: number; current: number }[];
  notes: string | null;
  author: { id: string; displayName: string };
  createdAt: string;
}

export const okrKeys = {
  all: ['okrs'] as const,
  tree: (period: string) => ['okrs', 'tree', period] as const,
  detail: (id: string) => ['okrs', 'detail', id] as const,
  scorecard: (period: string, departmentId?: string) => ['scorecard', period, departmentId ?? 'mine'] as const,
};

const failed = (fallback: string) => (e: unknown) => toast.error(e instanceof ApiError ? e.message : fallback);

export function useOkrTree(period: string) {
  return useQuery({ queryKey: okrKeys.tree(period), queryFn: ({ signal }) => api<OkrTree>('/okrs/tree', { signal, query: { period } }) });
}

export function useOkr(id: string | null) {
  return useQuery({
    queryKey: okrKeys.detail(id ?? 'none'),
    queryFn: ({ signal }) => api<{ okr: Okr; checkIns: CheckIn[] }>(`/okrs/${id}`, { signal }),
    enabled: !!id,
  });
}

export interface KeyResultDraft {
  id?: string;
  title: string;
  unit: string | null;
  startValue: number;
  target: number;
}

export interface OkrInput {
  period: string;
  level: OkrLevel;
  parentId: string | null;
  departmentId?: string;
  ownerUserId?: string;
  title: string;
  description: string | null;
  deadline: string | null;
  keyResults: KeyResultDraft[];
}

function useOkrMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: okrKeys.all });
      void qc.invalidateQueries({ queryKey: ['scorecard'] });
    },
  });
}

export function useSaveOkr() {
  // Errors are shown in the form.
  return useOkrMutation(({ id, input }: { id?: string; input: OkrInput }) => {
    if (!id) return api<{ okr: Okr }>('/okrs', { method: 'POST', body: input });
    const { title, description, deadline, keyResults, parentId } = input;
    return api<{ okr: Okr }>(`/okrs/${id}`, { method: 'PATCH', body: { title, description, deadline, keyResults, parentId } });
  });
}

export function useDeleteOkr() {
  const m = useOkrMutation((id: string) => api(`/okrs/${id}`, { method: 'DELETE' }));
  return { ...m, mutate: (id: string, opts?: { onSuccess?: () => void }) => m.mutate(id, { onError: failed('No se pudo eliminar el objetivo'), ...opts }) };
}

export function useCheckIn(id: string) {
  return useOkrMutation((body: { keyResults: { id: string; current: number }[]; notes: string | null }) =>
    api<{ okr: Okr; checkIns: CheckIn[] }>(`/okrs/${id}/check-ins`, { method: 'POST', body }),
  );
}

// ─── Scorecard ──────────────────────────────────────────────────────────────

export type TargetStatus = 'ON_TARGET' | 'AT_RISK' | 'BELOW' | 'NO_DATA';

export interface Kpi {
  value: number | null;
  delta: number | null;
}

export interface TrendPoint {
  period: string;
  performance: number | null;
  productivity: number | null;
  okrCompletion: number | null;
  okrProgress: number | null;
}

export type ScorecardAlert =
  | { kind: 'AREA_BELOW_TARGET'; severity: 'high' | 'medium'; department: { id: string; name: string; color: string | null }; value: number | null; target: number }
  | { kind: 'OKR_OFF_TRACK'; severity: 'high' | 'medium'; okr: { id: string; title: string; level: OkrLevel; progress: number; status: OkrStatus } };

export interface Scorecard {
  period: string;
  scope: 'company' | 'team';
  department: { id: string; name: string; target: number } | null;
  generatedAt: string;
  kpis: {
    performance: Kpi;
    okrCompletion: Kpi & { progress: number | null; count: number };
    collaboration: Kpi & { reason: 'NO_SOURCE' };
    productivity: Kpi;
    coverage: { people: number; withReview: number };
  };
  trend: TrendPoint[];
  areas?: {
    department: { id: string; name: string; color: string | null };
    people: number;
    withReview: number;
    performance: number | null;
    productivity: number | null;
    okrProgress: number | null;
    target: number;
    status: TargetStatus;
  }[];
  people?: {
    user: { id: string; displayName: string };
    review: { id: string; performance: number | null; productivity: number | null; dual: number | null; rating: PerformanceRating; published: boolean; recalculated: boolean } | null;
    okrProgress: number | null;
  }[];
  company?: { performance: number | null; productivity: number | null };
  alerts: ScorecardAlert[];
}

export function useScorecard(period: string, departmentId?: string) {
  return useQuery({
    queryKey: okrKeys.scorecard(period, departmentId),
    queryFn: ({ signal }) => api<Scorecard>('/performance-dashboard', { signal, query: { period, departmentId } }),
  });
}
