import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardArea, HistoryWeek, WeekDashboard } from '../../lib/types';

// The page talks to the API through lib/api; the network is replaced here.
const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api }));

const { default: DashboardPage } = await import('../../pages/DashboardPage');

const area = (id: string, name: string, index: number | null, semaphore: 'GREEN' | 'YELLOW' | 'RED' | null): DashboardArea => ({
  id,
  name,
  color: null,
  head: { id: `h-${id}`, displayName: `Jefe ${name}` },
  tasks: { total: 10, due: 8, done: 6, overdue: 2, blocked: 0 },
  kpis: { total: 2, recorded: 0 },
  functions: { total: 3, marked: 0 },
  taskProgress: index,
  kpiCompliance: null,
  functionCompliance: null,
  index,
  semaphore,
});

const AREAS = { mkt: area('mkt', 'MARKETING', 0.76, 'YELLOW'), fin: area('fin', 'FINANZAS', 0.93, 'GREEN') };

function dashboardFor(weekNumber: number, id: string, departmentId?: string): WeekDashboard {
  const departments = departmentId ? [AREAS[departmentId as keyof typeof AREAS]] : Object.values(AREAS);
  return {
    week: { id, mondayDate: '2026-09-28', saturdayDate: '2026-10-03', weekNumber, year: 2026, status: weekNumber === 40 ? 'ACTIVE' : 'ARCHIVED', archivedAt: null },
    today: '2026-09-29',
    cards: {
      index: departmentId ? departments[0]!.index : 0.76,
      semaphore: 'YELLOW',
      totalTasks: departmentId ? 10 : 287,
      doneTasks: departmentId ? 6 : 203,
      overdueTasks: 18,
      blockedTasks: 3,
      taskProgress: 0.76,
      kpiCompliance: null,
      functionCompliance: null,
      areasBySemaphore: { GREEN: 5, YELLOW: 6, RED: 2, NONE: 0 },
    },
    departments,
    charts: { taskStatus: { TODO: 0, IN_PROGRESS: 0, BLOCKED: 0, DONE: 0 }, taskSemaphore: { GREEN: 0, YELLOW: 0, RED: 0, GRAY: 0 }, criticalKpis: [] },
    generatedAt: '2026-09-29T15:00:00Z',
  };
}

const historyWeek = (n: number, index: number, status: 'ACTIVE' | 'ARCHIVED'): HistoryWeek => ({
  weekId: `w${n}`,
  weekNumber: n,
  year: 2026,
  mondayDate: '2026-09-21',
  saturdayDate: '2026-09-26',
  status,
  metrics: { indexGeneral: index, totalTasks: 42, completedTasks: 38, delayedTasks: 4, compliancePercentage: 90.5, taskProgress: null, kpiCompliance: null, functionCompliance: null, semaphore: 'YELLOW' },
  departmentMetrics: [],
});
const HISTORY = [historyWeek(38, 78.2, 'ARCHIVED'), historyWeek(39, 80, 'ARCHIVED'), historyWeek(40, 76, 'ACTIVE')];

function respond(opts: { failDashboard?: () => boolean; failHistory?: boolean } = {}) {
  api.mockImplementation(async (path: string, o: { query?: { departmentId?: string } } = {}) => {
    const departmentId = o.query?.departmentId;
    if (path === '/departments') {
      return { data: [{ id: 'mkt', slug: 'marketing', name: 'MARKETING' }, { id: 'fin', slug: 'finanzas', name: 'FINANZAS' }] };
    }
    if (path === '/dashboard/week/history') {
      if (opts.failHistory) throw new Error('down');
      return { weeks: HISTORY };
    }
    const week = path.match(/^\/dashboard\/week\/(.+)$/)?.[1];
    if (week) {
      if (opts.failDashboard?.()) throw new Error('down');
      return week === 'current' ? dashboardFor(40, 'w40', departmentId) : dashboardFor(Number(week.slice(1)), week, departmentId);
    }
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage(initial = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <DashboardPage /> },
      { path: '/tasks', element: <p>Tareas del área</p> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const called = (path: string) => api.mock.calls.filter(([p]) => p === path).map(([, o]) => o?.query ?? {});

afterEach(() => api.mockReset());

describe('DashboardPage', () => {
  it('shows the title and the current week', async () => {
    respond();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Dashboard Ejecutivo' })).toBeInTheDocument();
    expect(await screen.findByText(/Semana 40 · 28 sept – 3 oct/)).toBeInTheDocument();
  });

  it('displays the 7 metric cards, with the trend against last week', async () => {
    respond();
    renderPage();
    expect(await screen.findByRole('article', { name: /^Índice General: 76%, baja 4 pts/ })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(screen.getByRole('article', { name: /^② KPIs: —/ })).toBeInTheDocument();
  });

  it('summarizes areas by semaphore', async () => {
    respond();
    renderPage();
    const summary = await screen.findByRole('list', { name: 'Áreas por semáforo' });
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '🟢 5 en meta',
      '🟡 6 en riesgo',
      '🔴 2 críticas',
    ]);
  });

  it('opens the area on row click', async () => {
    respond();
    const router = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'FINANZAS' }));
    expect(router.state.location.pathname).toBe('/tasks');
    expect(router.state.location.search).toBe('?department=fin');
  });

  it('renders the four history charts', async () => {
    respond();
    renderPage();
    expect(await screen.findByRole('img', { name: /^Índice General por semana: S38 78,2%/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tendencia de Cumplimiento' })).toBeInTheDocument();
  });

  it('the area filter narrows table, cards and charts, and goes into the URL', async () => {
    respond();
    const router = renderPage();
    await screen.findByRole('row', { name: /MARKETING/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Área' }), 'finanzas');

    await waitFor(() => expect(screen.queryByRole('row', { name: /MARKETING/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /FINANZAS/ })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?area=finanzas');
    expect(called('/dashboard/week/current')).toContainEqual({ departmentId: 'fin' });
    expect(called('/dashboard/week/history')).toContainEqual({ limit: 3, departmentId: 'fin' });
  });

  it('the period filter loads that week and goes into the URL', async () => {
    respond();
    const router = renderPage();
    await screen.findByRole('option', { name: '-2 semanas (S38)' }); // weeks come with the history
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Período' }), '-2 semanas (S38)');
    expect(await screen.findByText(/Semana 38/)).toBeInTheDocument();
    expect(router.state.location.search).toBe('?week=38');
    expect(api).toHaveBeenCalledWith('/dashboard/week/w38', expect.anything());
  });

  it('reads filters from the URL and ignores unknown values', async () => {
    respond();
    renderPage('/?area=finanzas&week=39');
    expect(await screen.findByText(/Semana 39/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Área' })).toHaveDisplayValue('FINANZAS');
    expect(called('/dashboard/week/w39')).toContainEqual({ departmentId: 'fin' });

    api.mockClear();
    renderPage('/?area=<script>&week=99');
    await waitFor(() => expect(called('/dashboard/week/current')).toContainEqual({}));
  });

  it('shows an error with retry when the API fails, and a separate one for the history', async () => {
    let fail = true;
    respond({ failDashboard: () => fail, failHistory: true });
    renderPage();
    expect(await screen.findByText('No pudimos cargar el dashboard.')).toBeInTheDocument();
    expect((await screen.findAllByText('Error cargando datos históricos')).length).toBe(4);
    fail = false;
    await userEvent.click(within(screen.getByText('No pudimos cargar el dashboard.').closest('[role=alert]')!).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('row', { name: /MARKETING/ })).toBeInTheDocument();
  });
});
