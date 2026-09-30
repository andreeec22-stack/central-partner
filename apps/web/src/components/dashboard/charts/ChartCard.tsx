import { TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

// Chart palette — fixed, never branded, validated for color-blind separation
// (blue/red and blue/green pass the CVD and contrast checks on white).
export const CHART = {
  blue: '#2563eb',
  gray: '#a8a29e',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  grid: '#e3e0d6',
  axis: '#7a8092',
  threshold: '#dc2626',
  // The selected week of the period filter.
  highlight: 'rgba(37, 99, 235, 0.08)',
};

export const SEMAPHORE_COLOR = { green: CHART.green, yellow: CHART.yellow, red: CHART.red, gray: CHART.gray };

// The 70% "crítico" threshold drawn on percentage charts.
export const CRITICAL_THRESHOLD = 70;

export const axisProps = {
  tick: { fill: CHART.axis, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: CHART.grid },
} as const;

interface Column {
  label: string;
  value: (row: Record<string, unknown>) => ReactNode;
}

interface ChartCardProps {
  title: string;
  description: string;
  // Text alternative for the plot (screen readers).
  summary: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: string | null;
  // The same numbers as a table: a toggle for everyone, always there for screen readers.
  table: { rows: Record<string, unknown>[]; columns: Column[] };
  legend?: { label: string; color: string; shape?: 'dot' | 'line' | 'dash' }[];
  children: ReactNode;
}

export function ChartCard({ title, description, summary, loading, error, onRetry, empty, table, legend, children }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-card">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-bold">
            {title}
          </h3>
          <p className="text-xs text-muted">{description}</p>
        </div>
        {!loading && !error && !empty && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-brand hover:bg-sunken"
          >
            {showTable ? 'Ver gráfico' : 'Ver tabla'}
          </button>
        )}
      </header>

      <div className="mt-3 min-h-[15rem] flex-1">
        {loading ? (
          <div role="status" aria-label={`Cargando ${title}`} className="h-60 animate-pulse rounded-xl bg-sunken" />
        ) : error ? (
          <div role="alert" className="flex h-60 flex-col items-center justify-center gap-2 rounded-xl bg-sem-red-soft/50 text-sm text-sem-red">
            <TriangleAlert className="size-5" aria-hidden />
            Error cargando datos históricos
            {onRetry && (
              <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
                Reintentar
              </button>
            )}
          </div>
        ) : empty ? (
          <p className="flex h-60 items-center justify-center rounded-xl bg-paper text-sm text-muted">{empty}</p>
        ) : (
          <>
            {!showTable && (
              <div role="img" aria-label={summary} className="h-60">
                {children}
              </div>
            )}
            <table className={showTable ? 'w-full text-sm' : 'sr-only'}>
              <caption className="sr-only">{title}</caption>
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.label} scope="col" className="py-1.5 pr-3 font-semibold">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular">
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {table.columns.map((c) => (
                      <td key={c.label} className="py-1.5 pr-3">
                        {c.value(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {legend && !loading && !error && !empty && !showTable && (
        <ul aria-hidden className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              {l.shape === 'dash' ? (
                <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: l.color }} />
              ) : l.shape === 'line' ? (
                <span className="h-0.5 w-4 rounded" style={{ background: l.color }} />
              ) : (
                <span className="size-2.5 rounded-sm" style={{ background: l.color }} />
              )}
              {l.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
