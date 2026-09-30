import { useNavigate } from 'react-router';
import { DepartmentTable } from '../components/dashboard/DepartmentTable';
import { MetricsGrid } from '../components/dashboard/MetricsGrid';
import { SemaphoreIcon } from '../components/shared/SemaphoreIcon';
import { ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { toDepartmentRows, toMetrics, weekRangeLabel } from '../lib/dashboard';
import { useTrends, useWeekDashboard } from '../lib/queries';

// The director's weekly view: company cards and the per-area table. Numbers
// refresh live (socket events invalidate these queries).
export default function DashboardPage() {
  const navigate = useNavigate();
  const dashboard = useWeekDashboard('current');
  const trends = useTrends(2);
  const d = dashboard.data;
  const areas = d?.cards.areasBySemaphore;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Dashboard Ejecutivo</h1>
          {d ? (
            <p className="mt-1 text-sm text-muted">
              Semana {d.week.weekNumber} · {weekRangeLabel(d.week.mondayDate, d.week.saturdayDate)} · Control de áreas y desempeño
              {d.week.status === 'ARCHIVED' && <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-xs font-semibold">Cerrada</span>}
            </p>
          ) : (
            <Skeleton className="mt-2 h-4 w-72" />
          )}
        </div>
        {areas && (
          <ul aria-label="Áreas por semáforo" className="flex flex-wrap gap-2 text-sm">
            <li className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1 pr-3">
              <SemaphoreIcon type="green" size="sm" /> <strong className="tabular">{areas.GREEN}</strong> en meta
            </li>
            <li className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1 pr-3">
              <SemaphoreIcon type="yellow" size="sm" /> <strong className="tabular">{areas.YELLOW}</strong> en riesgo
            </li>
            <li className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1 pr-3">
              <SemaphoreIcon type="red" size="sm" /> <strong className="tabular">{areas.RED}</strong> críticas
            </li>
            {areas.NONE > 0 && (
              <li className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1 pr-3">
                <SemaphoreIcon type="gray" size="sm" /> <strong className="tabular">{areas.NONE}</strong> sin datos
              </li>
            )}
          </ul>
        )}
      </header>

      {dashboard.isError ? (
        <ErrorNotice message="No pudimos cargar el dashboard." onRetry={() => void dashboard.refetch()} />
      ) : (
        <>
          <section aria-labelledby="metrics-heading">
            <h2 id="metrics-heading" className="mb-4 text-lg font-bold">
              Métricas Generales
            </h2>
            <MetricsGrid metrics={d ? toMetrics(d, trends.data) : null} loading={!d} />
          </section>

          <section aria-labelledby="areas-heading">
            <h2 id="areas-heading" className="mb-4 text-lg font-bold">
              Detalle por Área
            </h2>
            <DepartmentTable
              departments={d ? toDepartmentRows(d) : []}
              loading={!d}
              onRowClick={(id) => navigate(`/tasks?department=${id}`)}
            />
            <p className="mt-2 text-xs text-muted">
              ① avance de las tareas vencidas hasta hoy · ② KPIs (se llenan el sábado) · ③ funciones · Índice = promedio de los que ya tienen datos.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
