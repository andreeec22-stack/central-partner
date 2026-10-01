import clsx from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AdminTable, td, th } from '../../components/admin/AdminKit';
import { axisProps, CHART, ChartCard } from '../../components/dashboard/charts/ChartCard';
import { OKR_STATUS_LABEL, OkrProgressBar, OkrStatusBadge } from '../../components/okrs/OkrBits';
import { periodLabel, RatingBadge, recentPeriods, Score } from '../../components/performance/PerfBits';
import { PerfNav } from '../../components/performance/PerfNav';
import { ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { formatDateTime, formatPercent } from '../../lib/format';
import { useOkrTree, useScorecard, type OkrStatus, type Scorecard, type TargetStatus } from '../../lib/okrs';
import { currentPeriod } from '../../lib/performance';
import { useDepartments } from '../../lib/queries';
import { useAuth } from '../../stores/auth';

const TARGET_LABEL: Record<TargetStatus, { text: string; tone: string }> = {
  ON_TARGET: { text: 'En meta', tone: 'text-sem-green' },
  AT_RISK: { text: 'Cerca de la meta', tone: 'text-ink' },
  BELOW: { text: 'Bajo la meta', tone: 'text-sem-red' },
  NO_DATA: { text: 'Sin datos', tone: 'text-muted' },
};

// `neutral`: a share that is expected to grow during the quarter (OKRs done), so
// it is not painted with the 90/70 semaphore.
export function KpiCard({ label, value, delta, hint, neutral }: { label: string; value: number | null; delta: number | null; hint?: string; neutral?: boolean }) {
  const Icon = delta === null || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const deltaText =
    delta === null ? 'sin trimestre anterior para comparar' : `${delta > 0 ? '+' : ''}${formatPercent(delta).replace('%', '')} puntos vs trimestre anterior`;
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 flex items-baseline gap-2">
        {neutral ? <span className="tabular text-2xl font-bold">{formatPercent(value)}</span> : <Score value={value} className="text-2xl" />}
        {value !== null && delta !== null && (
          <span className={clsx('inline-flex items-center text-xs font-semibold', delta > 0 ? 'text-sem-green' : delta < 0 ? 'text-sem-red' : 'text-muted')}>
            <Icon className="size-3.5" aria-hidden />
            <span className="sr-only">{deltaText}</span>
            <span aria-hidden>{`${delta > 0 ? '+' : ''}${formatPercent(delta)}`}</span>
          </span>
        )}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function TrendChart({ data }: { data: Scorecard['trend'] }) {
  const rows = data.map((d) => ({ ...d, label: periodLabel(d.period) }));
  const fmt = (v: unknown) => (typeof v === 'number' ? formatPercent(v) : '—');
  return (
    <ChartCard
      title="Tendencia (últimos 4 trimestres)"
      description="Desempeño, productividad y objetivos completados"
      summary={`Por trimestre: ${rows.map((r) => `${r.label}: desempeño ${fmt(r.performance)}, productividad ${fmt(r.productivity)}, objetivos ${fmt(r.okrCompletion)}`).join('; ')}.`}
      empty={rows.every((r) => r.performance === null && r.productivity === null && r.okrCompletion === null) ? 'Aún no hay resultados para comparar' : null}
      legend={[
        { label: 'Desempeño', color: CHART.blue, shape: 'line' },
        { label: 'Productividad', color: CHART.green, shape: 'line' },
        { label: 'Objetivos completados', color: CHART.yellow, shape: 'line' },
      ]}
      table={{
        rows: rows as unknown as Record<string, unknown>[],
        columns: [
          { label: 'Trimestre', value: (r) => r.label as string },
          { label: 'Desempeño', value: (r) => fmt(r.performance) },
          { label: 'Productividad', value: (r) => fmt(r.productivity) },
          { label: 'Objetivos', value: (r) => fmt(r.okrCompletion) },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 240 }}>
        <LineChart data={rows} margin={{ top: 16, right: 16, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis domain={[0, 100]} unit="%" width={48} {...axisProps} />
          <Tooltip formatter={(v) => fmt(v)} />
          <Line type="monotone" dataKey="performance" name="Desempeño" stroke={CHART.blue} strokeWidth={2} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="productivity" name="Productividad" stroke={CHART.green} strokeWidth={2} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="okrCompletion" name="Objetivos" stroke={CHART.yellow} strokeWidth={2} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function Alerts({ alerts }: { alerts: Scorecard['alerts'] }) {
  if (!alerts.length) return null;
  return (
    <section aria-labelledby="alerts" className="rounded-2xl border border-sem-red/30 bg-sem-red-soft/40 p-4">
      <h2 id="alerts" className="flex items-center gap-2 text-sm font-bold">
        <TriangleAlert className="size-4 text-sem-red" aria-hidden /> Alertas ({alerts.length})
      </h2>
      <ul className="mt-2 space-y-1 text-sm">
        {alerts.map((a, i) => (
          <li key={i}>
            {a.kind === 'AREA_BELOW_TARGET' ? (
              <>
                <strong>{a.department.name}</strong> está en {formatPercent(a.value)} de desempeño; su meta es {formatPercent(a.target)}.
              </>
            ) : (
              <>
                Objetivo <strong>{a.okr.title}</strong>: {formatPercent(a.okr.progress)} · {OKR_STATUS_LABEL[a.okr.status].toLowerCase()}.
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Worst first: below target, near it, on target, then areas without data.
const SEVERITY: Record<TargetStatus, number> = { BELOW: 0, AT_RISK: 1, ON_TARGET: 2, NO_DATA: 3 };
const sortAreas = (areas: NonNullable<Scorecard['areas']>) =>
  [...areas].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || (a.performance ?? 0) - (b.performance ?? 0));

function PerformanceTab({ data }: { data: Scorecard }) {
  const k = data.kpis;
  return (
    <div className="space-y-6">
      <section aria-label="Indicadores" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Desempeño promedio" value={k.performance.value} delta={k.performance.delta} hint={`${k.coverage.withReview} de ${k.coverage.people} personas con resultado`} />
        <KpiCard
          label="Objetivos completados"
          neutral
          value={k.okrCompletion.value}
          delta={k.okrCompletion.delta}
          hint={k.okrCompletion.count ? `${k.okrCompletion.count} objetivos · avance medio ${formatPercent(k.okrCompletion.progress)}` : 'Sin objetivos en el trimestre'}
        />
        <KpiCard label="Colaboración" value={null} delta={null} hint="Aún sin fuente de datos" />
        <KpiCard label="Productividad" value={k.productivity.value} delta={k.productivity.delta} hint="Tareas a tiempo y KPIs del área" />
      </section>

      {data.company && (
        <p className="text-sm text-muted">
          Empresa: desempeño {formatPercent(data.company.performance)} · productividad {formatPercent(data.company.productivity)}. Meta del área:{' '}
          {formatPercent(data.department?.target ?? null)}.
        </p>
      )}

      <Alerts alerts={data.alerts} />

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <TrendChart data={data.trend} />
        {data.areas ? (
          <AdminTable
            caption="Rendimiento por área"
            minWidth="32rem"
            head={
              <tr>
                <th className={th}>Área</th>
                <th className={th}>Desempeño</th>
                <th className={th}>Meta</th>
                <th className={th}>Estado</th>
                <th className={th}>Objetivos</th>
              </tr>
            }
          >
            {sortAreas(data.areas).map((a) => (
              <tr key={a.department.id}>
                <td className={td}>
                  <span className="flex items-center gap-2 font-semibold">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: a.department.color ?? 'var(--color-muted)' }} />
                    {a.department.name}
                  </span>
                  <span className="text-xs text-muted">
                    {a.withReview}/{a.people} con resultado
                  </span>
                </td>
                <td className={td}>
                  <Score value={a.performance} />
                </td>
                <td className={`${td} tabular`}>{formatPercent(a.target)}</td>
                <td className={clsx(td, 'text-xs font-semibold', TARGET_LABEL[a.status].tone)}>{TARGET_LABEL[a.status].text}</td>
                <td className={`${td} tabular`}>{formatPercent(a.okrProgress)}</td>
              </tr>
            ))}
          </AdminTable>
        ) : (
          <AdminTable
            caption="Personas del equipo"
            minWidth="32rem"
            head={
              <tr>
                <th className={th}>Persona</th>
                <th className={th}>Desempeño</th>
                <th className={th}>Productividad</th>
                <th className={th}>Calificación</th>
                <th className={th}>Objetivos</th>
              </tr>
            }
          >
            {(data.people ?? []).map((p) => (
              <tr key={p.user.id}>
                <td className={td}>
                  {p.review ? (
                    <Link to={`/performance/reviews/${p.review.id}`} className="font-semibold hover:underline">
                      {p.user.displayName}
                    </Link>
                  ) : (
                    <span className="font-semibold">{p.user.displayName}</span>
                  )}
                  {p.review?.recalculated && <span className="ml-2 rounded bg-sem-yellow-soft px-1.5 text-[11px] font-semibold">Recalculado</span>}
                </td>
                <td className={td}>
                  <Score value={p.review?.performance ?? null} />
                </td>
                <td className={td}>
                  <Score value={p.review?.productivity ?? null} />
                </td>
                <td className={td}>{p.review ? <RatingBadge rating={p.review.rating} /> : <span className="text-xs text-muted">Sin resultado</span>}</td>
                <td className={`${td} tabular`}>{formatPercent(p.okrProgress)}</td>
              </tr>
            ))}
          </AdminTable>
        )}
      </div>
    </div>
  );
}

function ObjectivesTab({ period }: { period: string }) {
  const tree = useOkrTree(period);
  if (tree.isPending) return <Skeleton className="h-40" />;
  if (tree.isError) return <ErrorNotice message="No se pudieron cargar los objetivos." onRetry={() => void tree.refetch()} />;
  const statuses: OkrStatus[] = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED'];
  return (
    <div className="space-y-4">
      <ul className="grid gap-3 sm:grid-cols-4">
        {statuses.map((st) => (
          <li key={st} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{OKR_STATUS_LABEL[st]}</p>
            <p className="tabular mt-1 text-2xl font-bold">{tree.data.summary[st]}</p>
          </li>
        ))}
      </ul>
      <ul className="space-y-3">
        {tree.data.roots.map((o) => (
          <li key={o.id} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{o.title}</p>
              <OkrStatusBadge status={o.status} />
            </div>
            <div className="mt-2">
              <OkrProgressBar progress={o.progress} expected={o.expectedProgress} status={o.status} label={`Avance de ${o.title}`} />
            </div>
            {o.children.length > 0 && <p className="mt-1 text-xs text-muted">{o.children.length} objetivos contribuyen a este</p>}
          </li>
        ))}
      </ul>
      <Link to="/performance/okrs" className="inline-block text-sm font-semibold text-brand hover:underline">
        Ver el árbol completo y registrar avances →
      </Link>
    </div>
  );
}

export default function ScorecardPage() {
  const me = useAuth((s) => s.user);
  const isAdmin = me?.role === 'ADMIN';
  const [period, setPeriod] = useState(currentPeriod());
  const [departmentId, setDepartmentId] = useState('');
  const [tab, setTab] = useState<'performance' | 'objectives'>('performance');
  const departments = useDepartments();
  const q = useScorecard(period, departmentId || undefined);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Dashboard de desempeño</h1>
          <p className="mt-1 text-sm text-muted">
            {q.data?.scope === 'team' ? `Equipo de ${q.data.department?.name}` : 'Toda la empresa'}
            {q.data && ` · actualizado ${formatDateTime(q.data.generatedAt, me?.timezone ?? 'America/Lima')}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Vista</span>
              <Select className="w-48" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Empresa</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Periodo</span>
            <Select className="w-36" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {recentPeriods(6).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
      <PerfNav />

      <div role="tablist" aria-label="Vistas del dashboard" className="inline-flex rounded-lg border border-line bg-surface p-1">
        {(
          [
            ['performance', 'Desempeño'],
            ['objectives', 'Objetivos'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx('rounded-md px-3 py-1.5 text-sm font-semibold transition', tab === key ? 'bg-navy text-white' : 'text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'objectives' ? (
          <ObjectivesTab period={period} />
        ) : q.isPending ? (
          <Skeleton className="h-96" />
        ) : q.isError ? (
          <ErrorNotice message="No se pudo cargar el dashboard." onRetry={() => void q.refetch()} />
        ) : (
          <PerformanceTab data={q.data} />
        )}
      </div>
    </div>
  );
}
