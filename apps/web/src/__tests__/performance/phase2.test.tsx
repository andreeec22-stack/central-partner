import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api }));

const { default: OkrsPage } = await import('../../pages/performance/OkrsPage');
const { default: ScorecardPage } = await import('../../pages/performance/ScorecardPage');
const { default: ReviewDetailPage } = await import('../../pages/performance/ReviewDetailPage');
const { CheckInForm } = await import('../../components/okrs/OkrDetailDialog');

function renderAt(path: string, routePath: string, element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: routePath, element }], { initialEntries: [path] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const okr = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  period: '2026-Q4',
  level: 'COMPANY',
  parentId: null,
  department: null,
  owner: null,
  title: 'Crecer 10%',
  description: null,
  deadline: null,
  progress: 30,
  expectedProgress: 50,
  status: 'AT_RISK',
  childrenCount: 0,
  lastCheckInAt: null,
  keyResults: [{ id: 'k1', title: 'Ventas', unit: '%', startValue: 0, target: 10, current: 3, progress: 30 }],
  permissions: { canEdit: true, canCheckIn: true },
  ...over,
});

function login(role: 'ADMIN' | 'JEFE_AREA' | 'USER') {
  useAuth.setState({
    status: 'authenticated',
    user: { id: 'me', workspaceId: 'w', email: 'x@central.local', displayName: 'Yo', role, canCreateTasks: false, departmentId: role === 'ADMIN' ? null : 'mkt', timezone: 'America/Lima' },
  });
}

beforeEach(() => login('ADMIN'));
afterEach(() => api.mockReset());

describe('OkrsPage', () => {
  it('shows the cascade with status, progress vs expected, and collapses children', async () => {
    const child = okr({ id: 'o2', level: 'AREA', parentId: 'o1', title: 'Más leads', department: { id: 'mkt', name: 'Marketing', color: null }, status: 'ON_TRACK', progress: 60 });
    api.mockImplementation(async (path: string) => {
      if (path === '/okrs/tree') return { period: '2026-Q4', summary: { ON_TRACK: 1, AT_RISK: 1, OFF_TRACK: 0, COMPLETED: 0, total: 2 }, roots: [{ ...okr(), children: [{ ...child, children: [] }] }] };
      throw new Error(path);
    });
    renderAt('/performance/okrs', '/performance/okrs', <OkrsPage />);

    expect(await screen.findByText('Crecer 10%')).toBeInTheDocument();
    expect(screen.getByText('Más leads')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Avance de Crecer 10%' })).toHaveAttribute('aria-valuetext', '30%; esperado a la fecha 50%');
    expect(screen.getAllByText('En riesgo').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Ocultar objetivos de Crecer 10%' }));
    expect(screen.queryByText('Más leads')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo objetivo' })).toBeInTheDocument();
  });

  it('collaborators get no create button', async () => {
    login('USER');
    api.mockResolvedValue({ period: '2026-Q4', summary: { ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETED: 0, total: 0 }, roots: [] });
    renderAt('/performance/okrs', '/performance/okrs', <OkrsPage />);
    expect(await screen.findByText('Sin objetivos en este trimestre')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /objetivo/ })).not.toBeInTheDocument();
  });
});

describe('CheckInForm', () => {
  it('sends only the key results that changed, plus the notes', async () => {
    api.mockResolvedValue({ okr: okr(), checkIns: [] });
    const client = new QueryClient();
    const o = okr({ keyResults: [okr().keyResults[0], { id: 'k2', title: 'NPS', unit: null, startValue: 50, target: 70, current: 55, progress: 25 }] });
    render(
      <QueryClientProvider client={client}>
        <CheckInForm okr={o as never} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Guardar avance' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Actualiza al menos un resultado clave');

    fireEvent.change(screen.getByLabelText('Valor actual de Ventas'), { target: { value: '6' } });
    await userEvent.type(screen.getByLabelText('Notas (bloqueos, cambios)'), 'Buena semana');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar avance' }));
    expect(api).toHaveBeenCalledWith('/okrs/o1/check-ins', { method: 'POST', body: { keyResults: [{ id: 'k1', current: 6 }], notes: 'Buena semana' } });
  });
});

const scorecard = {
  period: '2026-Q4',
  scope: 'company',
  department: null,
  generatedAt: '2026-10-05T15:00:00.000Z',
  kpis: {
    performance: { value: 72.5, delta: 5 },
    okrCompletion: { value: 25, delta: null, progress: 48, count: 4 },
    collaboration: { value: null, delta: null, reason: 'NO_SOURCE' },
    productivity: { value: 85, delta: -2 },
    coverage: { people: 10, withReview: 8 },
  },
  trend: [
    { period: '2026-Q1', performance: null, productivity: null, okrCompletion: null, okrProgress: null },
    { period: '2026-Q2', performance: 60, productivity: 80, okrCompletion: null, okrProgress: null },
    { period: '2026-Q3', performance: 67.5, productivity: 87, okrCompletion: 10, okrProgress: 30 },
    { period: '2026-Q4', performance: 72.5, productivity: 85, okrCompletion: 25, okrProgress: 48 },
  ],
  areas: [
    { department: { id: 'fin', name: 'Finanzas', color: null }, people: 3, withReview: 3, performance: 85, productivity: 90, okrProgress: 60, target: 80, status: 'ON_TARGET' },
    { department: { id: 'mkt', name: 'Marketing', color: null }, people: 4, withReview: 3, performance: 68, productivity: 70, okrProgress: 40, target: 85, status: 'BELOW' },
  ],
  alerts: [{ kind: 'AREA_BELOW_TARGET', severity: 'high', department: { id: 'mkt', name: 'Marketing', color: null }, value: 68, target: 85 }],
};

describe('ScorecardPage', () => {
  it('shows the four KPIs with their change, areas against their target and alerts', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/performance-dashboard') return scorecard;
      if (path === '/departments') return { data: [] };
      throw new Error(path);
    });
    renderAt('/performance/dashboard', '/performance/dashboard', <ScorecardPage />);

    const kpis = await screen.findByRole('region', { name: 'Indicadores' });
    expect(within(kpis).getByText('72,5%')).toBeInTheDocument();
    expect(within(kpis).getByText('+5 puntos vs trimestre anterior')).toBeInTheDocument();
    expect(within(kpis).getByText('-2 puntos vs trimestre anterior')).toBeInTheDocument();
    expect(within(kpis).getByText('Aún sin fuente de datos')).toBeInTheDocument();
    expect(within(kpis).getByText('8 de 10 personas con resultado')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Rendimiento por área' });
    expect(within(table).getByText('Bajo la meta')).toBeInTheDocument();
    expect(within(table).getByText('En meta')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Alertas/ })).toHaveTextContent('Marketing está en 68% de desempeño; su meta es 85%.');
  });
});

describe('ReviewDetailPage (CR-04)', () => {
  it('flags a recalculated result and offers recalculation to managers', async () => {
    api.mockResolvedValue({
      review: {
        id: 'r1',
        reviewPeriod: '2026-Q4',
        user: { id: 'ana', displayName: 'Ana', email: 'a' },
        department: { id: 'mkt', name: 'Marketing', color: null },
        surveysCompleted: 2,
        surveysInitiated: 2,
        selfAssessmentScore: 90,
        managerReviewScore: 60,
        overallPerformanceScore: 75,
        overallProductivityIndex: null,
        overallDualScore: 75,
        performanceRating: 'DEVELOPING',
        riskLevel: 'MEDIUM',
        performanceData: null,
        managerComments: null,
        employeeComments: null,
        strengths: [],
        areasForImprovement: [],
        developmentGoals: [],
        nextReviewDate: null,
        publishedAt: '2026-10-02T15:00:00.000Z',
        publishedBy: null,
        lastRecalculatedAt: '2026-10-04T15:00:00.000Z',
        recalculationCount: 1,
        updatedAt: '2026-10-04T15:00:00.000Z',
        permissions: { canEdit: true, canPublish: false, canComment: false },
      },
      surveys: [],
      okrs: [{ id: 'o9', title: 'Publicar contenido', progress: 45, status: 'ON_TRACK' }],
    });
    renderAt('/performance/reviews/r1', '/performance/reviews/:reviewId', <ReviewDetailPage />);
    expect(await screen.findByText(/^Recalculado el/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recalcular' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Objetivos del trimestre' })).toHaveTextContent('Publicar contenido');
  });
});
