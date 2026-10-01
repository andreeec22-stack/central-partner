import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '../stores/toast';
import { api, ApiError } from './api';

// Performance surveys: templates, evaluations, their answers and the quarterly
// reviews. Scores are 0–100 (null = no data). The API enforces who sees what;
// the `permissions` block on each item says what the viewer may do with it.

export type QuestionType = 'LIKERT_5' | 'LIKERT_7' | 'NUMERIC' | 'TEXT' | 'RANKING';
export type TemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type SurveyType = 'SELF_ASSESSMENT' | 'MANAGER_REVIEW';
export type SurveyStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type PerformanceRating = 'EXCEEDS_EXPECTATIONS' | 'MEETS_EXPECTATIONS' | 'DEVELOPING' | 'NEEDS_IMPROVEMENT' | 'NOT_YET_RATED';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type AnswerValue = number | string | string[];

export interface Question {
  id: string;
  questionNumber: number;
  text: string;
  questionType: QuestionType;
  weight: number;
  required: boolean;
  options: string[];
}

export interface QuestionDraft {
  text: string;
  questionType: QuestionType;
  weight: number;
  required: boolean;
  options: string[];
}

export interface SurveyTemplate {
  id: string;
  name: string;
  description: string | null;
  status: TemplateStatus;
  surveysCount: number;
  questions: Question[];
  updatedAt: string;
}

export interface DualScore {
  productivity_index: number | null;
  performance_score: number | null;
  overall_score: number | null;
  status: PerformanceRating;
}

interface Person {
  id: string;
  displayName: string;
}

export interface SurveySummary {
  id: string;
  title: string;
  description: string | null;
  type: SurveyType;
  status: SurveyStatus;
  isOverdue: boolean;
  template: { id: string; name: string };
  evaluator: Person;
  evaluatedUser: Person;
  department: { id: string; name: string; color: string | null };
  startDate: string;
  endDate: string;
  reviewPeriod: string;
  totalQuestions: number;
  answeredQuestions: number;
  completionPercentage: number;
  completedAt: string | null;
  productivityIndex: number | null;
  performanceScore: number | null;
  dualScore: DualScore | null;
  permissions: { canAnswer: boolean; canCancel: boolean };
}

export interface SurveyResponse {
  questionId: string;
  value: AnswerValue;
  comment: string | null;
}

export interface SurveyDetail extends SurveySummary {
  questions: Question[];
  responses: SurveyResponse[];
}

export interface PerformanceReview {
  id: string;
  reviewPeriod: string;
  user: Person & { email: string };
  department: { id: string; name: string; color: string | null } | null;
  surveysCompleted: number;
  surveysInitiated: number;
  selfAssessmentScore: number | null;
  managerReviewScore: number | null;
  overallPerformanceScore: number | null;
  overallProductivityIndex: number | null;
  overallDualScore: number | null;
  performanceRating: PerformanceRating;
  riskLevel: RiskLevel | null;
  managerComments: string | null;
  employeeComments: string | null;
  strengths: string[];
  areasForImprovement: string[];
  developmentGoals: string[];
  nextReviewDate: string | null;
  publishedAt: string | null;
  // CR-04: the result changed after it was published.
  lastRecalculatedAt: string | null;
  recalculationCount: number;
  updatedAt: string;
  permissions: { canEdit: boolean; canPublish: boolean; canComment: boolean };
}

export interface DashboardBlock {
  surveys: Record<SurveyStatus, number> & { overdue: number; total: number };
  completionRate: number | null;
  avgPerformanceScore: number | null;
  avgProductivityIndex: number | null;
  avgDualScore: number | null;
  reviews: { total: number; published: number; ratings: Record<PerformanceRating, number> };
}

export interface SurveyDashboard {
  period: string;
  totals: DashboardBlock;
  departments: (DashboardBlock & { department: { id: string; name: string; color: string | null } })[];
}

export const perfKeys = {
  templates: ['surveys', 'templates'] as const,
  surveys: ['surveys', 'list'] as const,
  survey: (id: string) => ['surveys', 'detail', id] as const,
  dashboard: (period?: string) => ['surveys', 'dashboard', period ?? 'current'] as const,
  reviews: ['reviews'] as const,
  review: (id: string) => ['reviews', id] as const,
};

const failed = (fallback: string) => (e: unknown) => toast.error(e instanceof ApiError ? e.message : fallback);

// "2026-Q3" for today.
export function currentPeriod(now = new Date()) {
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

// ─── Templates ──────────────────────────────────────────────────────────────

export function useTemplates(status?: TemplateStatus) {
  return useQuery({
    queryKey: [...perfKeys.templates, status ?? 'all'],
    queryFn: ({ signal }) => api<{ data: SurveyTemplate[] }>('/surveys/templates', { signal, query: { status } }).then((r) => r.data),
  });
}

export interface TemplateInput {
  name: string;
  description: string | null;
  questions: QuestionDraft[];
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: TemplateInput }) =>
      api<{ template: SurveyTemplate }>(id ? `/surveys/templates/${id}` : '/surveys/templates', { method: id ? 'PATCH' : 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: perfKeys.templates }),
  });
}

export function useTemplateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TemplateStatus }) =>
      api<{ template: SurveyTemplate }>(`/surveys/templates/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: perfKeys.templates }),
    onError: failed('No se pudo cambiar el estado de la plantilla'),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/surveys/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: perfKeys.templates }),
    onError: failed('No se pudo eliminar la plantilla'),
  });
}

// ─── Surveys ────────────────────────────────────────────────────────────────

export interface SurveyFilters {
  scope: 'all' | 'assigned';
  status?: SurveyStatus;
  departmentId?: string;
  period?: string;
  page: number;
}

export const SURVEYS_PAGE_SIZE = 25;

export function useSurveys(f: SurveyFilters, enabled = true) {
  return useQuery({
    queryKey: [...perfKeys.surveys, f],
    queryFn: ({ signal }) =>
      api<{ data: SurveySummary[]; pagination: { page: number; limit: number; total: number } }>('/surveys', {
        signal,
        query: { ...f, limit: SURVEYS_PAGE_SIZE },
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useSurvey(id: string) {
  return useQuery({
    queryKey: perfKeys.survey(id),
    queryFn: ({ signal }) => api<{ survey: SurveyDetail }>(`/surveys/${id}`, { signal }).then((r) => r.survey),
    // Answers being typed must not be overwritten by a background refetch.
    refetchOnWindowFocus: false,
  });
}

export interface CreateSurveyInput {
  templateId: string;
  type: SurveyType;
  evaluatedUserId: string;
  startDate: string;
  endDate: string;
  reviewPeriod?: string;
  title?: string;
}

export function useCreateSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSurveyInput) => api<{ survey: SurveyDetail }>('/surveys', { method: 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['surveys'] }),
  });
}

export interface AnswerInput {
  questionId: string;
  value: AnswerValue | null;
  comment?: string | null;
}

export function saveAnswers(id: string, answers: AnswerInput[]) {
  return api<{ survey: SurveyDetail }>(`/surveys/${id}/responses`, { method: 'POST', body: { answers } }).then((r) => r.survey);
}

export function useSubmitSurvey(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ survey: SurveyDetail }>(`/surveys/${id}/submit`, { method: 'POST' }).then((r) => r.survey),
    onSuccess: (survey) => {
      qc.setQueryData(perfKeys.survey(id), survey);
      void qc.invalidateQueries({ queryKey: perfKeys.surveys });
      void qc.invalidateQueries({ queryKey: perfKeys.reviews });
    },
  });
}

export function useCancelSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ survey: SurveyDetail }>(`/surveys/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['surveys'] }),
    onError: failed('No se pudo cancelar la encuesta'),
  });
}

export function useSurveyDashboard(period: string, enabled: boolean) {
  return useQuery({
    queryKey: perfKeys.dashboard(period),
    queryFn: ({ signal }) => api<SurveyDashboard>('/surveys/dashboard', { signal, query: { period } }),
    enabled,
  });
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export function useReviews(f: { period?: string; departmentId?: string; page: number }) {
  return useQuery({
    queryKey: [...perfKeys.reviews, f],
    queryFn: ({ signal }) =>
      api<{ data: PerformanceReview[]; pagination: { total: number } }>('/performance-reviews', { signal, query: { ...f, limit: SURVEYS_PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
}

export interface ReviewSurvey {
  id: string;
  title: string;
  type: SurveyType;
  status: SurveyStatus;
  performanceScore: number | null;
  productivityIndex: number | null;
  dualScore: DualScore | null;
  evaluator: Person;
}

export function useReview(id: string) {
  return useQuery({
    queryKey: perfKeys.review(id),
    queryFn: ({ signal }) =>
      api<{ review: PerformanceReview; surveys: ReviewSurvey[]; okrs: { id: string; title: string; progress: number; status: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'COMPLETED' }[] }>(
        `/performance-reviews/${id}`,
        { signal },
      ),
  });
}

export type ReviewPatch = Partial<
  Pick<PerformanceReview, 'managerComments' | 'employeeComments' | 'strengths' | 'areasForImprovement' | 'developmentGoals' | 'nextReviewDate'>
>;

export function useUpdateReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ReviewPatch) => api<{ review: PerformanceReview }>(`/performance-reviews/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: perfKeys.reviews }),
    onError: failed('No se pudieron guardar los cambios'),
  });
}

export function usePublishReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ review: PerformanceReview }>(`/performance-reviews/${id}/publish`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: perfKeys.reviews });
      void qc.invalidateQueries({ queryKey: ['surveys'] });
    },
    onError: failed('No se pudo publicar'),
  });
}

export function useRecalculateReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ review: PerformanceReview; recalculated: boolean }>(`/performance-reviews/${id}/recalculate`, { method: 'POST' }),
    onSuccess: ({ recalculated }) => {
      toast.success(recalculated ? 'Resultado recalculado' : 'El resultado ya estaba al día');
      void qc.invalidateQueries({ queryKey: perfKeys.reviews });
    },
    onError: failed('No se pudo recalcular'),
  });
}
