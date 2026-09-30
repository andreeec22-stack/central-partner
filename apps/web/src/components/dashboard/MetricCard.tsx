import clsx from 'clsx';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { SemaphoreIcon, type SemaphoreType } from '../shared/SemaphoreIcon';

export interface MetricCardProps {
  label: string;
  value: string | number | null;
  unit?: string;
  semaphore?: SemaphoreType;
  trend?: 'up' | 'down';
  trendValue?: string;
  // Second line under the value, e.g. "71% del total".
  hint?: ReactNode;
  loading?: boolean;
}

function formatValue(value: string | number | null) {
  if (value === null) return '—';
  return typeof value === 'number' ? new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value) : value;
}

export function MetricCard({ label, value, unit, semaphore, trend, trendValue, hint, loading = false }: MetricCardProps) {
  if (loading) {
    return (
      <div role="status" aria-label={`Cargando ${label}`} className="w-full rounded-2xl border border-line bg-surface p-4 shadow-card">
        <div className="h-4 w-24 animate-pulse rounded bg-sunken" />
        <div className="mt-4 h-8 w-20 animate-pulse rounded bg-sunken" />
      </div>
    );
  }

  const shown = formatValue(value);
  const hasValue = value !== null;
  const trendText = trend ? `${trend === 'up' ? 'sube' : 'baja'}${trendValue ? ` ${trendValue}` : ''} respecto a la semana anterior` : '';
  return (
    <article
      aria-label={`${label}: ${shown}${hasValue && unit ? unit : ''}${trendText ? `, ${trendText}` : ''}`}
      className="w-full rounded-2xl border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-soft">{label}</h3>
        {semaphore && <SemaphoreIcon type={semaphore} size="sm" />}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-3xl font-extrabold tabular tracking-tight">
          {shown}
          {hasValue && unit && <span className="ml-0.5 text-lg font-bold text-ink-soft">{unit}</span>}
        </p>
        {trend && (
          <span
            aria-hidden
            className={clsx('inline-flex items-center gap-0.5 text-sm font-bold tabular', trend === 'up' ? 'text-sem-green' : 'text-sem-red')}
          >
            {trend === 'up' ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
            {trendValue}
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </article>
  );
}
