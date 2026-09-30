import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api }));

const { ApiError } = await import('../../lib/api');
const { useAutoSave } = await import('../../lib/useAutoSave');
const { default: SurveyResponsePage } = await import('../../pages/performance/surveys/SurveyResponsePage');
const { templateProblems } = await import('../../pages/admin/SurveyTemplatesPage');

const QUESTIONS = [
  { id: 'q1', questionNumber: 1, text: 'Calidad del trabajo', questionType: 'LIKERT_5', weight: 1, required: true, options: [] },
  { id: 'q2', questionNumber: 2, text: 'Objetivos alcanzados', questionType: 'NUMERIC', weight: 2, required: true, options: [] },
  { id: 'q3', questionNumber: 3, text: 'Logros', questionType: 'TEXT', weight: 1, required: false, options: [] },
];

function survey(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    title: 'Autoevaluación · Ana · 2026-Q4',
    description: null,
    type: 'SELF_ASSESSMENT',
    status: 'ACTIVE',
    isOverdue: false,
    template: { id: 't1', name: 'Trimestral' },
    evaluator: { id: 'me', displayName: 'Ana' },
    evaluatedUser: { id: 'me', displayName: 'Ana' },
    department: { id: 'mkt', name: 'Marketing', color: null },
    startDate: '2026-10-01T00:00:00.000Z',
    endDate: '2026-10-15T00:00:00.000Z',
    reviewPeriod: '2026-Q4',
    totalQuestions: 3,
    answeredQuestions: 0,
    completionPercentage: 0,
    completedAt: null,
    productivityIndex: 80,
    performanceScore: null,
    dualScore: null,
    permissions: { canAnswer: true, canCancel: false },
    questions: QUESTIONS,
    responses: [],
    ...over,
  };
}

function renderSurvey() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/performance/surveys/:surveyId', element: <SurveyResponsePage /> }], { initialEntries: ['/performance/surveys/s1'] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuth.setState({
    status: 'authenticated',
    user: { id: 'me', workspaceId: 'w', email: 'ana@central.local', displayName: 'Ana', role: 'USER', canCreateTasks: false, departmentId: 'mkt', timezone: 'America/Lima' },
  });
});
afterEach(() => {
  api.mockReset();
  vi.useRealTimers();
});

describe('useAutoSave (Risk 7)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

  it('saves 30 s after the first change, with the latest value per key, and reports progress', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave<{ k: string; v: number }>(save, (c) => c.k), { wrapper });

    act(() => {
      result.current.queue({ k: 'a', v: 1 });
      result.current.queue({ k: 'b', v: 2 });
      result.current.queue({ k: 'a', v: 3 });
    });
    expect(result.current.status).toBe('pending');
    await act(async () => void vi.advanceTimersByTime(29_000));
    expect(save).not.toHaveBeenCalled();

    await act(async () => void vi.advanceTimersByTime(1_000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith([
      { k: 'a', v: 3 },
      { k: 'b', v: 2 },
    ]);
    expect(result.current.status).toBe('saved');
    expect(result.current.lastSavedAt).toBeInstanceOf(Date);

    // Nothing new → no more saves.
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps the changes when a save fails and retries on the next round, without throwing', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave<{ k: string }>(save, (c) => c.k), { wrapper });

    act(() => result.current.queue({ k: 'a' }));
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(result.current.status).toBe('error');
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([{ k: 'a' }]);
    expect(result.current.status).toBe('saved');
  });

  it('flush() saves immediately', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave<{ k: string }>(save, (c) => c.k), { wrapper });
    act(() => result.current.queue({ k: 'a' }));
    let ok = false;
    await act(async () => {
      ok = await result.current.flush();
    });
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledWith([{ k: 'a' }]);
  });
});

describe('SurveyResponsePage', () => {
  it('auto-saves answers as a draft and shows it', async () => {
    api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/surveys/s1' && !opts?.method) return { survey: survey() };
      if (path === '/surveys/s1/responses') return { survey: survey({ answeredQuestions: 1 }) };
      throw new Error(path);
    });
    renderSurvey();
    expect(await screen.findByText('Tus respuestas se guardan automáticamente')).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText('4'));
    expect(screen.getByText('Cambios sin guardar · se guardan solos cada 30 s')).toBeInTheDocument();
    expect(screen.getByText('1 de 3 respondidas')).toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(api).toHaveBeenCalledWith('/surveys/s1/responses', { method: 'POST', body: { answers: [{ questionId: 'q1', value: 4 }] } });
    expect(screen.getByText(/^Borrador guardado/)).toBeInTheDocument();
  });

  it('saves pending answers before submitting and marks the missing ones', async () => {
    api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/surveys/s1' && !opts?.method) return { survey: survey() };
      if (path === '/surveys/s1/responses') return { survey: survey() };
      if (path === '/surveys/s1/submit') throw new ApiError(422, 'SURVEY_INCOMPLETE', 'Faltan 1 preguntas obligatorias por responder', { missingQuestionIds: ['q2'] });
      throw new Error(path);
    });
    renderSurvey();
    fireEvent.click(await screen.findByLabelText('5'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(await screen.findByText('Responde esta pregunta para enviar')).toBeInTheDocument();
    const calls = api.mock.calls.map((c) => c[0]);
    expect(calls.indexOf('/surveys/s1/responses')).toBeLessThan(calls.indexOf('/surveys/s1/submit'));
  });

  it('is read-only once submitted, and shows the scores', async () => {
    api.mockResolvedValue({
      survey: survey({
        status: 'COMPLETED',
        permissions: { canAnswer: false, canCancel: false },
        performanceScore: 91.3,
        dualScore: { productivity_index: 80, performance_score: 91.3, overall_score: 85.7, status: 'MEETS_EXPECTATIONS' },
        responses: [{ questionId: 'q1', value: 5, comment: null }],
      }),
    });
    renderSurvey();
    expect(await screen.findByText('Enviada: ya no se puede editar.')).toBeInTheDocument();
    expect(screen.getByLabelText('5')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();
    expect(screen.getByText('Cumple expectativas')).toBeInTheDocument();
    expect(screen.getByText('85,7%')).toBeInTheDocument();
  });

  it('explains when the survey is not accessible', async () => {
    api.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'No tienes acceso'));
    renderSurvey();
    expect(await screen.findByText('Esta encuesta no existe o no tienes acceso a ella.')).toBeInTheDocument();
  });
});

describe('template rules in the editor (Risk 3)', () => {
  const q = (questionType: string, extra = {}) => ({ text: 'Pregunta', questionType, weight: 1, required: true, options: [], ...extra }) as never;

  it('mirrors the API: 3+ questions, one scored, ranking options', () => {
    expect(templateProblems('T', [q('LIKERT_5'), q('TEXT')])).toContain('Necesita al menos 3 preguntas.');
    expect(templateProblems('T', [q('TEXT'), q('TEXT'), q('TEXT')]).join(' ')).toMatch(/al menos una pregunta con escala/);
    expect(templateProblems('T', [q('LIKERT_5'), q('TEXT'), q('RANKING', { options: ['solo una'] })])).toContain('La pregunta 3 (ranking) necesita al menos 2 opciones.');
    expect(templateProblems('', [q('LIKERT_5'), q('TEXT'), q('NUMERIC')])).toEqual(['Ponle un nombre a la plantilla.']);
    expect(templateProblems('T', [q('LIKERT_5'), q('TEXT'), q('NUMERIC')])).toEqual([]);
  });
});
