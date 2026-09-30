import type { HistoryPoint } from '../../../lib/dashboard';

interface Row {
  label: string;
  value: string;
  color: string;
}

// Recharts passes { active, payload }; the first payload carries the week point.
export function ChartTooltip({ active, payload, rows }: { active?: boolean; payload?: { payload: HistoryPoint }[]; rows: (p: HistoryPoint) => Row[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="font-bold text-ink">
        {point.label}
        {point.current && <span className="ml-1 font-semibold text-muted">(actual)</span>}
      </p>
      <p className="mb-1 text-muted">{point.range}</p>
      {rows(point).map((r) => (
        <p key={r.label} className="flex items-center gap-1.5 text-ink-soft">
          <span aria-hidden className="size-2 rounded-sm" style={{ background: r.color }} />
          {r.label}: <strong className="tabular text-ink">{r.value}</strong>
        </p>
      ))}
    </div>
  );
}

export const pct = (v: number | null) => (v === null ? '—' : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(v)}%`);
