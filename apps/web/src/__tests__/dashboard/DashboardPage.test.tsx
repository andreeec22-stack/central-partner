import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrendPoint, WeekDashboard } from '../../lib/types';

// The page talks to the API through lib/api; the network is replaced here.
const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api }));

const { default: DashboardPage } = await import('../../pages/DashboardPage');

const area = (id: string, name: string, index: number | null, semaphore: 'GREEN' | 'YELLOW' | 'RED' | null) => ({
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

const dashboard: WeekDashboard = {
  week: { id: 'w40', mondayDate: '2026-09-28', saturdayDate: '2026-10-03', weekNumber: 40, year: 2026, status: 'ACTIVE', archivedAt: null },
  today: '2026-09-29',
  cards: {
    index: 0.76,
    semaphore: 'YELLOW',
    totalTasks: 287,
    doneTasks: 203,
    overdueTasks: 18,
    blockedTasks: 3,
    taskProgress: 0.76,
    kpiCompliance: null,
    functionCompliance: null,
    areasBySemaphore: { GREEN: 5, YELLOW: 6, RED: 2, NONE: 0 },
  },
  departments: [area('mkt', 'MARKETING', 0.76, 'YELLOW'), area('fin', 'FINANZAS', 0.93, 'GREEN')],
  charts: { taskStatus: { TODO: 0, IN_PROGRESS: 0, BLOCKED: 0, DONE: 0 }, taskSemaphore: { GREEN: 0, YELLOW: 0, RED: 0, GRAY: 0 }, criticalKpis: [] },
  generatedAt: '2026-09-29T15:00:00Z',
};

const trend = (index: number): TrendPoint => ({
  week: { id: 'w', mondayDate: '', saturdayDate: '', weekNumber: 0, year: 2026, status: 'ARCHIVED' },
  index,
  taskProgress: null,
  kpiCompliance: null,
  functionCompliance: null,
  semaphore: null,
});

function respond(overrides: { dashboard?: WeekDashboard | Error } = {}) {
  api.mockImplementation(async (path: string) => {
    if (path === '/dashboard/week/current') {
      if (overrides.dashboard instanceof Error) throw overrides.dashboard;
      return overrides.dashboard ?? dashboard;
    }
    if (path === '/dashboard/trends') return { data: [trend(0.8), trend(0.76)] };
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/', element: <DashboardPage /> },
      { path: '/tasks', element: <p>Tareas del área</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => api.mockReset());

describe('DashboardPage', () => {
  it('shows the title and the current week', async () => {
    respond();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Dashboard Ejecutivo' })).toBeInTheDocument();
    expect(await screen.findByText(/Semana 40 · 28 sept – 3 oct/)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/dashboard/week/current', expect.anything());
  });

  it('displays the 7 metric cards with the API numbers', async () => {
    respond();
    renderPage();
    const index = await screen.findByRole('article', { name: /^Índice General: 76%, baja 4 pts/ });
    expect(index).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    expect(screen.getByRole('article', { name: /^Total Tareas: 287/ })).toBeInTheDocument();
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

  it('displays the department table with its rows', async () => {
    respond();
    renderPage();
    expect(await screen.findByRole('row', { name: /MARKETING/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /FINANZAS/ })).toHaveTextContent('93%');
  });

  it('opens the area on row click', async () => {
    respond();
    const router = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'FINANZAS' }));
    expect(router.state.location.pathname).toBe('/tasks');
    expect(router.state.location.search).toBe('?department=fin');
    expect(screen.getByText('Tareas del área')).toBeInTheDocument();
  });

  it('shows skeletons while loading and an error with retry when the API fails', async () => {
    let fail = true;
    api.mockImplementation(async (path: string) => {
      if (path === '/dashboard/trends') return { data: [] };
      if (fail) throw new Error('down');
      return dashboard;
    });
    renderPage();
    expect(screen.getByRole('status', { name: 'Cargando áreas' })).toBeInTheDocument();
    expect(await screen.findByText('No pudimos cargar el dashboard.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('row', { name: /MARKETING/ })).toBeInTheDocument();
  });
});
