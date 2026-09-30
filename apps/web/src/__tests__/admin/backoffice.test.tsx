import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';

const api = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api, download, saveBlob }));

const { ApiError } = await import('../../lib/api');
const { CreateUserModal } = await import('../../components/admin/UserModals');
const { CloseWeekModal } = await import('../../components/admin/CloseWeekModal');
const { JefePermissionRow } = await import('../../pages/admin/PermissionsPage');
const { default: AuditLogsPage } = await import('../../pages/admin/AuditLogsPage');

const DEPARTMENTS = [
  { id: 'mkt', slug: 'marketing', name: 'Marketing', color: null, description: null, headId: null, usersCount: 3 },
  { id: 'fin', slug: 'finanzas', name: 'Finanzas', color: null, description: null, headId: null, usersCount: 2 },
];

function withProviders(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  useAuth.setState({
    status: 'authenticated',
    user: { id: 'me', workspaceId: 'w', email: 'director@central.local', displayName: 'Directora', role: 'ADMIN', canCreateTasks: true, departmentId: null, timezone: 'America/Lima' },
  });
});
afterEach(() => {
  api.mockReset();
  download.mockReset();
});

describe('CreateUserModal', () => {
  it('validates as you type and invites with the right payload, then shows the link', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/departments') return { data: DEPARTMENTS };
      if (path === '/users') return { invitationId: 'i1', inviteUrl: 'http://localhost:5173/accept-invite?token=abc', expiresAt: '' };
      throw new Error(path);
    });
    withProviders(<CreateUserModal open onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Enviar invitación' }));
    expect(screen.getByText('Escribe un correo válido')).toBeInTheDocument();
    expect(screen.getByText('Elige el departamento')).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('/users', expect.anything());

    await userEvent.type(screen.getByLabelText('Correo'), 'Nueva@Central.com');
    await userEvent.selectOptions(screen.getByLabelText('Rol'), 'JEFE_AREA');
    await userEvent.selectOptions(await screen.findByLabelText('Departamento'), await screen.findByRole('option', { name: 'Finanzas' }));
    await userEvent.click(screen.getByLabelText(/Puede crear tareas/));
    await userEvent.type(screen.getByLabelText('WhatsApp (opcional)'), '+51 999 123 456');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar invitación' }));

    expect(api).toHaveBeenCalledWith('/users', {
      method: 'POST',
      body: { email: 'nueva@central.com', role: 'JEFE_AREA', departmentId: 'fin', canCreateTasks: true, phoneNumber: '+51999123456' },
    });
    expect(await screen.findByDisplayValue('http://localhost:5173/accept-invite?token=abc')).toBeInTheDocument();
  });

  it('shows "already has an account" on the email field', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/departments') return { data: DEPARTMENTS };
      throw new ApiError(409, 'USER_EXISTS', 'exists');
    });
    withProviders(<CreateUserModal open onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Correo'), 'ana@central.local');
    await userEvent.selectOptions(await screen.findByLabelText('Departamento'), await screen.findByRole('option', { name: 'Marketing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enviar invitación' }));
    expect(await screen.findByText('Ya tiene una cuenta en este espacio')).toBeInTheDocument();
  });
});

const week = { id: 'w39', mondayDate: '2026-09-21', saturdayDate: '2026-09-26', weekNumber: 39, year: 2026, status: 'ACTIVE' as const, archivedAt: null, createdAt: '' };
const report = (canClose: boolean) => ({
  week,
  canClose,
  closableAt: '2026-09-26T15:00:00Z',
  incompleteCount: 1,
  departments: [
    { departmentId: 'mkt', departmentName: 'Marketing', tasksWithoutProgress: 0, kpisMissing: 0, functionsUnmarked: 0, noKpis: false, noFunctions: false, complete: true },
    { departmentId: 'rrhh', departmentName: 'RRHH', tasksWithoutProgress: 0, kpisMissing: 2, functionsUnmarked: 0, noKpis: false, noFunctions: false, complete: false },
  ],
});

describe('CloseWeekModal', () => {
  it('validates each area, closes anyway on confirmation, and offers the file', async () => {
    api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/weeks/w39/closure-check') return report(true);
      if (path === '/weeks/w39/close') {
        expect(opts).toEqual({ method: 'POST', body: { force: true } });
        return { week: { ...week, status: 'ARCHIVED' }, nextWeek: { ...week, id: 'w40', weekNumber: 40, mondayDate: '2026-09-28', saturdayDate: '2026-10-03' }, carriedTasks: 3, overall: { index: 0.825 }, incompleteAreas: 1 };
      }
      throw new Error(path);
    });
    download.mockResolvedValue({ blob: new Blob(), filename: 'DashboardCentralPartner_Week39.xlsx' });
    withProviders(<CloseWeekModal week={week} onClose={vi.fn()} onViewHistory={vi.fn()} />);

    const areas = await screen.findByRole('list', { name: 'Validación por área' });
    expect(within(areas).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Marketing — OK', 'RRHH — 2 KPIs sin real']);
    await userEvent.click(screen.getByRole('button', { name: 'Sí, cerrar igual' }));

    expect(await screen.findByText('✅ Semana 39 archivada')).toBeInTheDocument();
    expect(screen.getByText(/3 tareas sin terminar pasan a la nueva semana/)).toBeInTheDocument();
    expect(screen.getByText(/índice final 82,5%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Descargar Excel' }));
    expect(download).toHaveBeenCalledWith('/weeks/w39/export', expect.objectContaining({ method: 'POST' }));
  });

  it('keeps the close button off before Saturday 10:00', async () => {
    api.mockResolvedValue(report(false));
    withProviders(<CloseWeekModal week={week} onClose={vi.fn()} onViewHistory={vi.fn()} />);
    expect(await screen.findByText(/el cierre se habilita el sábado desde las 10:00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sí, cerrar igual' })).toBeDisabled();
  });
});

describe('JefePermissionRow', () => {
  it('saves task creation and the extra visible areas', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/departments') return { data: DEPARTMENTS };
      if (path === '/permissions/JEFE_AREA') return { jefes: [] };
      throw new Error(path);
    });
    const jefe = { id: 'j1', displayName: 'Jefe Marketing', email: 'j@x.com', departmentId: 'mkt', departmentName: 'Marketing', canCreateTasks: false, visibleDepartmentIds: [] };
    withProviders(
      <ul>
        <JefePermissionRow jefe={jefe} />
      </ul>,
    );
    // Its own area is not offered.
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Finanzas' }));
    expect(screen.queryByRole('checkbox', { name: 'Marketing' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Puede crear tareas' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(api).toHaveBeenCalledWith('/permissions/JEFE_AREA', { method: 'PATCH', body: { userId: 'j1', canCreateTasks: true, visibleDepartmentIds: ['fin'] } });
  });
});

describe('AuditLogsPage', () => {
  const entry = {
    id: 'l1',
    timestamp: '2026-09-30T15:45:00Z',
    action: 'USER_INVITED',
    actionLabel: 'Invitó usuario',
    entityType: 'Invitation',
    entityId: 'i1',
    entityLabel: 'nuevo@central.local',
    user: { id: 'me', name: 'Directora', email: 'director@central.local' },
    changes: { role: { old: 'USER', new: 'JEFE_AREA' } },
    metadata: null,
    ipAddress: null,
  };

  it('lists entries, filters by action and exports with the same filters', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/users') return { data: [], total: 0, page: 1, limit: 100 };
      if (path === '/audit-logs') return { data: [entry], total: 1, page: 1, limit: 100 };
      throw new Error(path);
    });
    download.mockResolvedValue({ blob: new Blob(), filename: 'auditoria.csv' });
    withProviders(<AuditLogsPage />);

    const row = await screen.findByRole('row', { name: /Invitó usuario/ });
    expect(row).toHaveTextContent('nuevo@central.local');
    await userEvent.click(within(row).getByText('Ver cambios (1)'));
    expect(within(row).getByText('rol:')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Acción'), 'WEEK_CLOSED');
    await waitFor(() => expect(api).toHaveBeenCalledWith('/audit-logs', expect.objectContaining({ query: expect.objectContaining({ action: 'WEEK_CLOSED', page: 1 }) })));
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    expect(download).toHaveBeenCalledWith('/audit-logs/export', expect.objectContaining({ query: expect.objectContaining({ action: 'WEEK_CLOSED', format: 'csv' }) }));
  });
});

describe('admin routes', () => {
  it('send anyone but an ADMIN back to the dashboard', async () => {
    useAuth.setState({ user: { ...useAuth.getState().user!, role: 'JEFE_AREA' } });
    const { router: appRouter } = await import('../../router');
    const client = new QueryClient();
    const router = createMemoryRouter(appRouter.routes, { initialEntries: ['/admin/settings/users'] });
    api.mockImplementation(async () => new Promise(() => undefined)); // pages stay loading
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
