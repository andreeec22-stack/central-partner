import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';

const api = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), api, download, saveBlob }));

const { default: ReportsPage } = await import('../../pages/admin/ReportsPage');

const report = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  week: { id: 'w39', weekNumber: 39, year: 2026, mondayDate: '2026-09-21' },
  source: 'WEEK_CLOSED',
  filename: 'Reporte_Semana39_2026.xlsx',
  sizeBytes: 48_000,
  rowCount: 300,
  sheetCount: 16,
  generatedBy: { id: 'd', displayName: 'Directora' },
  createdAt: '2026-09-26T15:10:00.000Z',
  expiresAt: '2026-10-26T15:10:00.000Z',
  deletedAt: null,
  status: 'AVAILABLE',
  downloadUrl: '/api/v1/export/r1/download',
  ...over,
});

beforeEach(() => {
  useAuth.setState({
    status: 'authenticated',
    user: { id: 'd', workspaceId: 'w', email: 'director@central.local', displayName: 'Directora', role: 'ADMIN', canCreateTasks: true, departmentId: null, timezone: 'America/Lima' },
  });
});
afterEach(() => {
  api.mockReset();
  download.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

describe('ReportsPage', () => {
  it('lists reports, downloads through the API and regenerates a closed week', async () => {
    api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/export' && !opts?.method) return { data: [report(), report({ id: 'r2', status: 'DELETED', deletedAt: '2026-09-27T00:00:00Z', week: { id: 'w38', weekNumber: 38, year: 2026, mondayDate: '2026-09-14' } })] };
      if (path === '/weeks/archived') return { data: [{ id: 'w39', weekNumber: 39, mondayDate: '2026-09-21' }], total: 1, page: 1, limit: 20 };
      if (path === '/export/generate-weekly') return { report: report({ id: 'r3', source: 'MANUAL' }) };
      if (path === '/export/r2/restore') return { report: report({ id: 'r2' }) };
      throw new Error(path);
    });
    download.mockResolvedValue({ blob: new Blob(['x']), filename: 'Reporte_Semana39_2026.xlsx' });
    renderPage();

    const table = await screen.findByRole('table', { name: 'Reportes semanales' });
    const row = within(table).getByText('Semana 39').closest('tr')!;
    expect(within(row).getByText('Cierre de semana')).toBeInTheDocument();
    expect(within(row).getByText('47 KB · 16 hojas')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Descargar' }));
    expect(download).toHaveBeenCalledWith('/export/r1/download', { fallbackName: 'Reporte_Semana39_2026.xlsx' });
    expect(saveBlob).toHaveBeenCalled();

    await userEvent.click(within(within(table).getByText('Semana 38').closest('tr')!).getByRole('button', { name: 'Restaurar' }));
    expect(api).toHaveBeenCalledWith('/export/r2/restore', { method: 'POST' });

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Semana cerrada' }), 'w39');
    await userEvent.click(screen.getByRole('button', { name: 'Generar de nuevo' }));
    expect(api).toHaveBeenCalledWith('/export/generate-weekly', { method: 'POST', body: { weekId: 'w39', format: 'xlsx' } });
  });

  it('explains where reports come from when there are none', async () => {
    api.mockImplementation(async (path: string) => (path === '/export' ? { data: [] } : { data: [], total: 0, page: 1, limit: 20 }));
    renderPage();
    expect(await screen.findByText('Aún no hay reportes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generar de nuevo' })).toBeDisabled();
  });
});
