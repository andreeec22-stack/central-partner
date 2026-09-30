import { semaphoreForPercent } from '../shared/SemaphoreIcon';
import { MetricCard } from './MetricCard';

// Percentages 0–100; null when there is nothing to measure yet (e.g. KPIs
// before Saturday).
export interface DashboardMetrics {
  index: number | null;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  metric1: number | null; // ① avance de tareas
  metric2: number | null; // ② KPIs
  metric3: number | null; // ③ funciones
  // Index change vs last week, in percentage points.
  indexDelta?: number | null;
}

interface MetricsGridProps {
  metrics: DashboardMetrics | null;
  loading?: boolean;
}

const LABELS = ['Índice General', 'Total Tareas', 'Completadas', 'Atrasadas', '① Avance', '② KPIs', '③ Funciones'];

export function MetricsGrid({ metrics, loading = false }: MetricsGridProps) {
  if (loading || !metrics) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LABELS.map((label) => (
          <MetricCard key={label} label={label} value={null} loading />
        ))}
      </div>
    );
  }

  const m = metrics;
  const delta = m.indexDelta ?? null;
  const completedShare = m.totalTasks ? Math.round((m.completedTasks / m.totalTasks) * 100) : null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label="Índice General"
        value={m.index}
        unit="%"
        semaphore={semaphoreForPercent(m.index)}
        trend={delta === null || delta === 0 ? undefined : delta > 0 ? 'up' : 'down'}
        trendValue={delta === null || delta === 0 ? undefined : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(Math.abs(delta))} pts`}
        hint="(① + ② + ③) ÷ 3"
      />
      <MetricCard label="Total Tareas" value={m.totalTasks} hint="de la semana" />
      <MetricCard label="Completadas" value={m.completedTasks} hint={completedShare === null ? undefined : `${completedShare}% del total`} />
      <MetricCard label="Atrasadas" value={m.overdueTasks} hint="su día ya pasó sin llegar al 100%" />
      <MetricCard label="① Avance" value={m.metric1} unit="%" semaphore={semaphoreForPercent(m.metric1)} hint="tareas vencidas hasta hoy" />
      <MetricCard
        label="② KPIs"
        value={m.metric2}
        unit="%"
        semaphore={semaphoreForPercent(m.metric2)}
        hint={m.metric2 === null ? 'se llenan el sábado' : 'cumplimiento real ÷ meta'}
      />
      <MetricCard
        label="③ Funciones"
        value={m.metric3}
        unit="%"
        semaphore={semaphoreForPercent(m.metric3)}
        hint={m.metric3 === null ? 'se marcan el sábado' : 'Sí = 1 · Parcial = ½ · No = 0'}
      />
    </div>
  );
}
