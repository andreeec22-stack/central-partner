import { Download, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, download, saveBlob } from '../../lib/api';
import { toast } from '../../stores/toast';

interface ExportButtonProps {
  // Current filters: the file matches what's on screen.
  weekId?: string; // id or "current"
  weekNumber?: number;
  areaId?: string;
  disabled?: boolean;
  // Ctrl+E / ⌘+E triggers it (only one per page should set this).
  shortcut?: boolean;
}

export function ExportButton({ weekId = 'current', weekNumber, areaId, disabled, shortcut }: ExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const run = useRef<() => void>(() => undefined);

  const exportExcel = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const { blob, filename } = await download('/dashboard/export/excel', {
        method: 'POST',
        body: { weekId, ...(areaId ? { areaId } : {}), format: 'xlsx' },
        fallbackName: `DashboardCentralPartner_Week${weekNumber ?? ''}.xlsx`,
      });
      saveBlob(blob, filename);
      toast.success(`Excel descargado: ${filename}`);
    } catch (error) {
      toast.error(error instanceof ApiError && error.status < 500 ? `Error generando Excel: ${error.message}` : 'Error generando Excel');
    } finally {
      setBusy(false);
    }
  };
  run.current = () => void exportExcel();

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        run.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);

  return (
    <button
      type="button"
      onClick={() => void exportExcel()}
      disabled={disabled || busy}
      aria-label={busy ? 'Exportando a Excel…' : 'Exportar el dashboard a Excel'}
      aria-keyshortcuts={shortcut ? 'Control+E Meta+E' : undefined}
      title={shortcut ? 'Exportar a Excel (Ctrl+E)' : undefined}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white shadow-card transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-55"
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
      {busy ? 'Exportando…' : 'Exportar a Excel'}
    </button>
  );
}
