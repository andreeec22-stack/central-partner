import clsx from 'clsx';
import { useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AnalyticsGrid } from '../components/dashboard/AnalyticsGrid';
import { DashboardFilters, type FilterOption } from '../components/dashboard/DashboardFilters';
import { DepartmentTable } from '../components/dashboard/DepartmentTable';
import { ExportButton } from '../components/dashboard/ExportButton';
import { MetricsGrid } from '../components/dashboard/MetricsGrid';
import { SemaphoreIcon } from '../components/shared/SemaphoreIcon';
import { ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { toDepartmentRows, toHistoryPoints, toMetrics, weekRangeLabel } from '../lib/dashboard';
import { useDepartments, useWeekDashboard, useWeekHistory } from '../lib/queries';

// Filters live in the URL (?area=<slug>&week=<number>) so a view can be shared
// or bookmarked. Unknown values are ignored rather than trusted.
function useDashboardFilters() {
  const [params, setParams] = useSearchParams();
  const set = (key: 'area' | 'week', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  return {
    areaSlug: (params.get('area') ?? '').slice(0, 100),
    weekParam: /^\d{1,2}$/.test(params.get('week') ?? '') ? params.get('week')! : '',
    setArea: (v: string) => set('area', v),
    setWeek: (v: string) => set('week', v),
  };
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const areaSelect = useRef<HTMLSelectElement>(null);
  const filters = useDashboardFilters();
  const departments = useDepartments();

  const area = departments.data?.find((d) => d.slug === filters.areaSlug);
  const history = useWeekHistory(area?.id);
  const weeks = history.data ?? [];
  const selectedWeek = weeks.find((w) => String(w.weekNumber) === filters.weekParam && w.status === 'ARCHIVED');
  const dashboard = useWeekDashboard(selectedWeek?.weekId ?? 'current', area?.id);
  const d = dashboard.data;

  const points = useMemo(() => toHistoryPoints(weeks), [weeks]);
  const shownWeekId = selectedWeek?.weekId ?? weeks.find((w) => w.status === 'ACTIVE')?.weekId;
  const shownIndex = points.findIndex((p) => p.weekId === shownWeekId);
  const previousIndex = shownIndex > 0 ? points[shownIndex - 1]!.index : null;

  const areaOptions: FilterOption[] = (departments.data ?? []).map((dep) => ({ value: dep.slug, label: dep.name }));
  // Newest first: the current week, then the closed ones.
  const weekOptions: FilterOption[] = [...weeks].reverse().map((w, i) => ({
    value: w.status === 'ACTIVE' ? '' : String(w.weekNumber),
    label: w.status === 'ACTIVE' ? `Semana actual (S${w.weekNumber})` : `-${i} ${i === 1 ? 'semana' : 'semanas'} (S${w.weekNumber})`,
  }));
  const areas = d?.cards.areasBySemaphore;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Dashboard Ejecutivo</h1>
          {d ? (
            <p className="mt-1 text-sm text-muted">
              Semana {d.week.weekNumber} · {weekRangeLabel(d.week.mondayDate, d.week.saturdayDate)} · {area ? area.name : 'Control de áreas y desempeño'}
              {d.week.status === 'ARCHIVED' && <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-xs font-semibold">Cerrada</span>}
            </p>
          ) : (
            <Skeleton className="mt-2 h-4 w-72" />
          )}
        </div>
        {areas && !area && (
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

      <DashboardFilters
        ref={areaSelect}
        areas={areaOptions}
        weeks={weekOptions}
        area={area?.slug ?? ''}
        week={selectedWeek ? String(selectedWeek.weekNumber) : ''}
        onAreaChange={filters.setArea}
        onWeekChange={filters.setWeek}
        actions={<ExportButton weekId={d?.week.id} weekNumber={d?.week.weekNumber} areaId={area?.id} disabled={!d || d.departments.length === 0} shortcut />}
      />

      {dashboard.isError ? (
        <ErrorNotice message="No pudimos cargar el dashboard." onRetry={() => void dashboard.refetch()} />
      ) : (
        <div className={clsx('space-y-8 transition-opacity', dashboard.isPlaceholderData && 'opacity-60')}>
          <section aria-labelledby="metrics-heading">
            <h2 id="metrics-heading" className="mb-4 text-lg font-bold">
              Métricas Generales
            </h2>
            <MetricsGrid metrics={d ? toMetrics(d, previousIndex) : null} loading={!d} />
          </section>

          <section aria-labelledby="areas-heading">
            <h2 id="areas-heading" className="mb-4 text-lg font-bold">
              Detalle por Área
            </h2>
            <DepartmentTable departments={d ? toDepartmentRows(d) : []} loading={!d} onRowClick={(id) => navigate(`/tasks?department=${id}`)} />
            <p className="mt-2 text-xs text-muted">
              ① avance de las tareas vencidas hasta hoy · ② KPIs (se llenan el sábado) · ③ funciones · Índice = promedio de los que ya tienen datos.
            </p>
          </section>
        </div>
      )}

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="mb-1 text-lg font-bold">
          Evolución
        </h2>
        <p className="mb-4 text-sm text-muted">Últimas 3 semanas cerradas y la actual{area ? ` · ${area.name}` : ''}. La semana elegida se resalta.</p>
        <AnalyticsGrid
          points={points}
          selectedWeekId={shownWeekId}
          loading={history.isLoading}
          error={history.isError}
          onRetry={() => void history.refetch()}
        />
      </section>
    </div>
  );
}
