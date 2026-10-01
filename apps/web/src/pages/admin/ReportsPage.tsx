import { Download, FileSpreadsheet, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, AdminTable, ConfirmDialog, td, th } from '../../components/admin/AdminKit';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { downloadReport, useArchivedWeeks, useDeleteReport, useGenerateReport, useReports, useRestoreReport, type WeeklyReport } from '../../lib/admin';
import { formatDate, formatDateTime } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';

const STATUS = {
  AVAILABLE: { text: 'Disponible', tone: 'bg-sem-green-soft text-sem-green' },
  DELETED: { text: 'Eliminado', tone: 'bg-sunken text-muted' },
  EXPIRED: { text: 'Vencido', tone: 'bg-paper text-muted ring-1 ring-line' },
} as const;

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

// The weekly Excel reports: generated when a week closes (or here, on demand),
// kept 30 days. Admin only, like the API.
export default function ReportsPage() {
  const tz = useAuth((s) => s.user?.timezone) ?? 'America/Lima';
  const [showDeleted, setShowDeleted] = useState(false);
  const [weekId, setWeekId] = useState('');
  const [deleting, setDeleting] = useState<WeeklyReport | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const reports = useReports(showDeleted);
  const weeks = useArchivedWeeks(1);
  const generate = useGenerateReport();
  const remove = useDeleteReport();
  const restore = useRestoreReport();

  return (
    <div className="space-y-6">
      <AdminPageHeader
        section="Operación"
        title="Reportes semanales"
        description="Se generan solos al cerrar cada semana: resumen, una hoja por área, histórico de 12 semanas y notas. Se guardan 30 días."
      />

      <section aria-label="Generar un reporte" className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-surface p-4 shadow-card">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Semana cerrada</span>
          <span className="w-64">
            <Select aria-label="Semana cerrada" value={weekId} onChange={(e) => setWeekId(e.target.value)}>
              <option value="">Elegir</option>
              {weeks.data?.data.map((w) => (
                <option key={w.id} value={w.id}>
                  Semana {w.weekNumber} · {w.mondayDate}
                </option>
              ))}
            </Select>
          </span>
        </label>
        <Button
          icon={<FileSpreadsheet className="size-4" aria-hidden />}
          disabled={!weekId}
          loading={generate.isPending}
          onClick={() => generate.mutate(weekId, { onSuccess: () => toast.success('Reporte generado') })}
        >
          Generar de nuevo
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          Ver eliminados y vencidos
        </label>
      </section>

      {reports.isPending ? (
        <Skeleton className="h-48" />
      ) : reports.isError ? (
        <ErrorNotice message="No se pudieron cargar los reportes." onRetry={() => void reports.refetch()} />
      ) : reports.data.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet className="size-6" />} title="Aún no hay reportes">
          El primero se genera al cerrar la semana desde Gestión de semanas.
        </EmptyState>
      ) : (
        <AdminTable
          caption="Reportes semanales"
          head={
            <tr>
              <th className={th}>Semana</th>
              <th className={th}>Generado</th>
              <th className={th}>Origen</th>
              <th className={th}>Tamaño</th>
              <th className={th}>Vence</th>
              <th className={th}>Estado</th>
              <th className={th}>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          }
        >
          {reports.data.map((r) => (
            <tr key={r.id}>
              <td className={td}>
                <span className="font-semibold">Semana {r.week.weekNumber}</span>
                <span className="block text-xs text-muted">{r.week.mondayDate}</span>
              </td>
              <td className={td}>
                {formatDateTime(r.createdAt, tz)}
                <span className="block text-xs text-muted">{r.generatedBy?.displayName ?? 'Sistema'}</span>
              </td>
              <td className={`${td} text-xs`}>{r.source === 'WEEK_CLOSED' ? 'Cierre de semana' : 'Manual'}</td>
              <td className={`${td} tabular`}>
                {size(r.sizeBytes)} · {r.sheetCount} hojas
              </td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(r.expiresAt, tz)}</td>
              <td className={td}>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[r.status].tone}`}>{STATUS[r.status].text}</span>
              </td>
              <td className={`${td} text-right whitespace-nowrap`}>
                {r.status === 'AVAILABLE' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Download className="size-4" aria-hidden />}
                      loading={downloading === r.id}
                      onClick={async () => {
                        setDownloading(r.id);
                        await downloadReport(r);
                        setDownloading(null);
                      }}
                    >
                      Descargar
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Eliminar reporte de la semana ${r.week.weekNumber}`} onClick={() => setDeleting(r)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
                {r.status === 'DELETED' && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => restore.mutate(r.id)}>
                    Restaurar
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </AdminTable>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="¿Eliminar este reporte?"
        description={deleting ? `Semana ${deleting.week.weekNumber}. Podrás restaurarlo hasta que venza.` : undefined}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  );
}
