import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../../stores/toast';

const download = vi.hoisted(() => vi.fn());
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({ ...(await original<typeof import('../../lib/api')>()), download, saveBlob }));

const { ExportButton } = await import('../../components/dashboard/ExportButton');
const { ApiError } = await import('../../lib/api');

afterEach(() => {
  download.mockReset();
  saveBlob.mockReset();
  useToasts.setState({ toasts: [] });
});

const file = { blob: new Blob(['xlsx']), filename: 'DashboardCentralPartner_Week40_Marketing.xlsx' };

describe('ExportButton', () => {
  it('POSTs the current filters and saves the file', async () => {
    download.mockResolvedValue(file);
    render(<ExportButton weekId="w40" weekNumber={40} areaId="mkt" />);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar el dashboard a Excel' }));
    expect(download).toHaveBeenCalledWith('/dashboard/export/excel', {
      method: 'POST',
      body: { weekId: 'w40', areaId: 'mkt', format: 'xlsx' },
      fallbackName: 'DashboardCentralPartner_Week40.xlsx',
    });
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(file.blob, file.filename));
    expect(useToasts.getState().toasts[0]).toMatchObject({ tone: 'success' });
  });

  it('is disabled with a spinner while exporting', async () => {
    let finish!: (v: typeof file) => void;
    download.mockReturnValue(new Promise((r) => (finish = r)));
    render(<ExportButton />);
    await userEvent.click(screen.getByRole('button'));
    const busy = screen.getByRole('button', { name: 'Exportando a Excel…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveTextContent('Exportando…');
    finish(file);
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  });

  it('shows an error toast when the export fails', async () => {
    download.mockRejectedValue(new ApiError(500, 'HTTP_ERROR', 'boom'));
    render(<ExportButton />);
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(useToasts.getState().toasts[0]).toMatchObject({ tone: 'error', message: 'Error generando Excel' }));
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('exports with Ctrl+E, and not when disabled', async () => {
    download.mockResolvedValue(file);
    const { rerender } = render(<ExportButton shortcut disabled />);
    await userEvent.keyboard('{Control>}e{/Control}');
    expect(download).not.toHaveBeenCalled();
    rerender(<ExportButton shortcut />);
    await userEvent.keyboard('{Control>}e{/Control}');
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
  });
});
