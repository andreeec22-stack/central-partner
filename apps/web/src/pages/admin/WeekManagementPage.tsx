import { CalendarDays, Download, Eye, Lock } from 'lucide-react';
import { useRef, useState } from 'react';
import { AdminPageHeader, AdminTable, Pagination, StatusBadge, td, th } from '../../components/admin/AdminKit';
import { CloseWeekModal } from '../../components/admin/CloseWeekModal';
import { DepartmentTable } from '../../components/dashboard/DepartmentTable';
import { MetricsGrid } from '../../components/dashboard/MetricsGrid';
import { SemaphoreIcon, toSemaphoreType } from '../../components/shared/SemaphoreIcon';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { downloadWeek, useArchivedWeeks, useClosureCheck, useWeeksOverview, type WeekRow } from '../../lib/admin';
import { toDepartmentRows, toMetrics, weekRangeLabel } from '../../lib/dashboard';
import { formatDate, formatDateTime, formatPercent, toPercent } from '../../lib/format';
import { useWeekDashboard } from '../../lib/queries';
import { useAuth } from '../../stores/auth';

function WeekSnapshotModal({ week, onClose }: { week: WeekRow | null; onClose: () => void }) {
  const data = useWeekDashboard(week?.id ?? 'current');
  const d = week ? data.data : undefined;
  return (
    <Dialog wide open={!!week} onClose={onClose} title={`Semana ${week?.weekNumber ?? ''} (archivada)`} description={week ? weekRangeLabel(week.mondayDate, week.saturdayDate) : undefined}>
      <div className="space-y-4">
        <MetricsGrid metrics={d && d.week.id === week?.id ? toMetrics(d) : null} loading={!d || d.week.id !== week?.id} />
        <DepartmentTable departments={d && d.week.id === week?.id ? toDepartmentRows(d) : []} loading={!d || d.week.id !== week?.id} />
      </div>
    </Dialog>
  );
}

function ActiveWeekCard({ week, onClose }: { week: WeekRow; onClose: (w: WeekRow) => void }) {
  const me = useAuth((s) => s.user)!;
  const check = useClosureCheck(week.id);
  const canClose = check.data?.canClose ?? false;
  return (
    <section aria-labelledby={`week-${week.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted">
            <CalendarDays className="size-4" aria-hidden /> Semana activa
          </p>
          <h2 id={`week-${week.id}`} className="mt-1 text-xl font-extrabold">
            Semana {week.weekNumber} <span className="font-semibold text-ink-soft">({weekRangeLabel(week.mondayDate, week.saturdayDate)})</span>
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <StatusBadge active>ACTIVA</StatusBadge>
            Creada {formatDateTime(week.createdAt, me.timezone)}
          </p>
        </div>
        <div className="text-right">
          <Button icon={<Lock className="size-4" />} disabled={!canClose} onClick={() => onClose(week)}>
            Iniciar cierre semanal
          </Button>
          {check.data && !canClose && (
            <p className="mt-1.5 text-xs text-muted">Disponible desde el {formatDateTime(check.data.closableAt, me.timezone)}</p>
          )}
          {check.data && (
            <p className="mt-1 text-xs text-muted">
              {check.data.incompleteCount ? `${check.data.incompleteCount} áreas con datos pendientes` : 'Todas las áreas completas'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function WeekManagementPage() {
  const me = useAuth((s) => s.user)!;
  const overview = useWeeksOverview();
  const [page, setPage] = useState(1);
  const archived = useArchivedWeeks(page);
  const [closing, setClosing] = useState<WeekRow | null>(null);
  const [viewing, setViewing] = useState<WeekRow | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const archivedRef = useRef<HTMLElement>(null);

  const current = overview.data?.current;
  // Earlier weeks that were never closed (e.g. a Saturday nobody closed).
  const pending = (overview.data?.data ?? []).filter((w) => w.status === 'ACTIVE' && current && w.mondayDate < current.mondayDate);

  const download = async (w: WeekRow) => {
    setDownloading(w.id);
    await downloadWeek(w.id, w.weekNumber);
    setDownloading(null);
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader title="Gestión de semanas" description="Cada lunes se abre una semana sola. El sábado desde las 10:00 se cierra: se valida, se archiva y lo pendiente pasa a la siguiente." />

      {overview.isError ? (
        <ErrorNotice message="No pudimos cargar las semanas." onRetry={() => void overview.refetch()} />
      ) : !current ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <ActiveWeekCard week={current} onClose={setClosing} />
      )}

      {pending.length > 0 && (
        <section aria-labelledby="pending-heading" className="space-y-2">
          <h2 id="pending-heading" className="text-sm font-bold text-sem-red">
            Semanas anteriores sin cerrar
          </h2>
          <ul className="divide-y divide-line rounded-2xl border border-sem-red/30 bg-surface shadow-card">
            {pending.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-semibold">S{w.weekNumber}</span> · {weekRangeLabel(w.mondayDate, w.saturdayDate)}
                </span>
                <Button size="sm" variant="secondary" icon={<Lock className="size-4" />} onClick={() => setClosing(w)}>
                  Cerrar
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section ref={archivedRef} aria-labelledby="archived-heading" className="space-y-3">
        <h2 id="archived-heading" className="text-lg font-bold">
          📜 Semanas archivadas
        </h2>
        {archived.isError ? (
          <ErrorNotice message="No pudimos cargar el histórico." onRetry={() => void archived.refetch()} />
        ) : archived.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !archived.data?.data.length ? (
          <EmptyState icon={<CalendarDays className="size-5" />} title="Todavía no hay semanas cerradas">
            Aparecerán aquí después del primer cierre semanal.
          </EmptyState>
        ) : (
          <>
            <AdminTable
              caption="Semanas archivadas"
              head={
                <tr>
                  <th scope="col" className={th}>
                    Semana
                  </th>
                  <th scope="col" className={th}>
                    Fechas
                  </th>
                  <th scope="col" className={th}>
                    Archivada
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Índice
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Tareas
                  </th>
                  <th scope="col" className={th}>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              }
            >
              {archived.data.data.map((w) => (
                <tr key={w.id} className="hover:bg-paper/60">
                  <td className={`${td} font-bold`}>S{w.weekNumber}</td>
                  <td className={`${td} whitespace-nowrap text-ink-soft`}>{weekRangeLabel(w.mondayDate, w.saturdayDate)}</td>
                  <td className={`${td} whitespace-nowrap text-ink-soft`}>
                    {w.archivedAt ? formatDate(w.archivedAt, me.timezone) : '—'}
                    {w.archivedBy && <span className="block text-xs text-muted">por {w.archivedBy.displayName}</span>}
                  </td>
                  <td className={`${td} text-right`}>
                    <span className="inline-flex items-center gap-2 font-bold tabular">
                      {formatPercent(toPercent(w.index))}
                      <SemaphoreIcon type={toSemaphoreType(w.semaphore)} size="sm" />
                    </span>
                  </td>
                  <td className={`${td} text-right tabular text-ink-soft`}>{w.tasks ? `${w.tasks.done}/${w.tasks.total}` : '—'}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    <Button variant="ghost" size="sm" icon={<Eye className="size-4" />} onClick={() => setViewing(w)}>
                      Ver
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Download className="size-4" />} loading={downloading === w.id} onClick={() => void download(w)}>
                      Excel
                    </Button>
                  </td>
                </tr>
              ))}
            </AdminTable>
            <Pagination page={page} total={archived.data.total} pageSize={20} onPage={setPage} label="semanas archivadas" />
          </>
        )}
      </section>

      <CloseWeekModal week={closing} onClose={() => setClosing(null)} onViewHistory={() => archivedRef.current?.scrollIntoView({ behavior: 'smooth' })} />
      <WeekSnapshotModal week={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
