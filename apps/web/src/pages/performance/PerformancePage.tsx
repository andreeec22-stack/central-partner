import { ClipboardCheck, Plus, Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AdminTable, ConfirmDialog, Pagination, td, th } from '../../components/admin/AdminKit';
import { CreateSurveyModal } from '../../components/performance/CreateSurveyModal';
import { periodLabel, recentPeriods, Score, SurveyStatusBadge, SURVEY_TYPE_LABEL } from '../../components/performance/PerfBits';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { formatDate, formatPercent } from '../../lib/format';
import {
  currentPeriod,
  SURVEYS_PAGE_SIZE,
  useCancelSurvey,
  useSurveyDashboard,
  useSurveys,
  type SurveyStatus,
  type SurveySummary,
} from '../../lib/performance';
import { useAuth } from '../../stores/auth';

function MySurveys({ tz }: { tz: string }) {
  const q = useSurveys({ scope: 'assigned', page: 1 });
  const open = q.data?.data.filter((s) => s.status === 'ACTIVE' || s.status === 'SCHEDULED') ?? [];
  const done = q.data?.data.filter((s) => s.status === 'COMPLETED') ?? [];
  return (
    <section aria-labelledby="mine" className="space-y-3">
      <h2 id="mine" className="text-lg font-bold">
        Por completar
      </h2>
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <ErrorNotice message="No se pudieron cargar tus encuestas." onRetry={() => void q.refetch()} />
      ) : open.length === 0 ? (
        <EmptyState icon={<ClipboardCheck className="size-6" />} title="Nada pendiente">
          Cuando te asignen una evaluación aparecerá aquí.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {open.map((s) => (
            <li key={s.id}>
              <Link to={`/performance/surveys/${s.id}`} className="block rounded-2xl border border-line bg-surface p-4 shadow-card transition hover:border-brand/50">
                <div className="flex items-center justify-between gap-2">
                  <SurveyStatusBadge status={s.status} overdue={s.isOverdue} />
                  <span className="text-xs text-muted">vence el {formatDate(s.endDate, tz)}</span>
                </div>
                <p className="mt-2 font-semibold">{s.type === 'SELF_ASSESSMENT' ? 'Tu autoevaluación' : `Evaluar a ${s.evaluatedUser.displayName}`}</p>
                <p className="text-sm text-muted">{s.template.name}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                  <div className="h-full rounded-full bg-brand" style={{ width: `${s.completionPercentage}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {s.answeredQuestions} de {s.totalQuestions} respondidas
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <p className="text-sm text-muted">
          Enviadas:{' '}
          {done.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ' · '}
              <Link className="font-semibold text-ink hover:underline" to={`/performance/surveys/${s.id}`}>
                {s.type === 'SELF_ASSESSMENT' ? 'Autoevaluación' : s.evaluatedUser.displayName} ({s.reviewPeriod})
              </Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function TeamDashboard({ period }: { period: string }) {
  const q = useSurveyDashboard(period, true);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError) return <ErrorNotice message="No se pudo cargar el resumen." onRetry={() => void q.refetch()} />;
  const t = q.data.totals;
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          ['Evaluaciones', `${t.surveys.COMPLETED} / ${t.surveys.total - t.surveys.CANCELLED}`, 'enviadas'],
          ['Vencidas', String(t.surveys.overdue), 'sin enviar'],
          ['Puntaje combinado', formatPercent(t.avgDualScore), 'promedio'],
          ['Resultados publicados', `${t.reviews.published} / ${t.reviews.total}`, 'personas'],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
            <dd className="tabular mt-1 text-2xl font-bold">{value}</dd>
            <dd className="text-xs text-muted">{hint}</dd>
          </div>
        ))}
      </dl>
      {q.data.departments.length > 1 && (
        <AdminTable
          caption="Resumen por departamento"
          minWidth="40rem"
          head={
            <tr>
              <th className={th}>Área</th>
              <th className={th}>Enviadas</th>
              <th className={th}>Vencidas</th>
              <th className={th}>Encuesta</th>
              <th className={th}>Productividad</th>
              <th className={th}>Combinado</th>
            </tr>
          }
        >
          {q.data.departments
            .filter((d) => d.surveys.total > 0)
            .map((d) => (
              <tr key={d.department.id}>
                <td className={td}>
                  <span className="flex items-center gap-2 font-semibold">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: d.department.color ?? 'var(--color-muted)' }} />
                    {d.department.name}
                  </span>
                </td>
                <td className={`${td} tabular`}>
                  {d.surveys.COMPLETED} / {d.surveys.total - d.surveys.CANCELLED}
                </td>
                <td className={`${td} tabular`}>{d.surveys.overdue}</td>
                <td className={td}>
                  <Score value={d.avgPerformanceScore} />
                </td>
                <td className={td}>
                  <Score value={d.avgProductivityIndex} />
                </td>
                <td className={td}>
                  <Score value={d.avgDualScore} />
                </td>
              </tr>
            ))}
        </AdminTable>
      )}
    </div>
  );
}

function TeamSurveys({ period, tz }: { period: string; tz: string }) {
  const [status, setStatus] = useState<SurveyStatus | ''>('');
  const [page, setPage] = useState(1);
  const [cancelling, setCancelling] = useState<SurveySummary | null>(null);
  const q = useSurveys({ scope: 'all', period, status: status || undefined, page });
  const cancel = useCancelSurvey();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">Evaluaciones del periodo</h3>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Estado</span>
          <Select
            className="w-44"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as SurveyStatus | '');
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Abiertas</option>
            <option value="SCHEDULED">Programadas</option>
            <option value="COMPLETED">Enviadas</option>
            <option value="CANCELLED">Canceladas</option>
          </Select>
        </label>
      </div>
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <ErrorNotice message="No se pudieron cargar las evaluaciones." onRetry={() => void q.refetch()} />
      ) : q.data.data.length === 0 ? (
        <EmptyState icon={<ClipboardCheck className="size-6" />} title="Sin evaluaciones en este periodo" />
      ) : (
        <>
          <AdminTable
            caption="Evaluaciones"
            head={
              <tr>
                <th className={th}>Persona</th>
                <th className={th}>Tipo</th>
                <th className={th}>Evaluador</th>
                <th className={th}>Estado</th>
                <th className={th}>Vence</th>
                <th className={th}>Avance</th>
                <th className={th}>Combinado</th>
                <th className={th}>
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            }
          >
            {q.data.data.map((s) => (
              <tr key={s.id}>
                <td className={td}>
                  <Link to={`/performance/surveys/${s.id}`} className="font-semibold hover:underline">
                    {s.evaluatedUser.displayName}
                  </Link>
                  <p className="text-xs text-muted">{s.department.name}</p>
                </td>
                <td className={td}>{SURVEY_TYPE_LABEL[s.type]}</td>
                <td className={td}>{s.evaluator.displayName}</td>
                <td className={td}>
                  <SurveyStatusBadge status={s.status} overdue={s.isOverdue} />
                </td>
                <td className={`${td} whitespace-nowrap`}>{formatDate(s.endDate, tz)}</td>
                <td className={`${td} tabular`}>{formatPercent(s.completionPercentage)}</td>
                <td className={td}>
                  <Score value={s.dualScore?.overall_score ?? null} />
                </td>
                <td className={`${td} text-right`}>
                  {s.permissions.canCancel && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelling(s)}>
                      Cancelar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </AdminTable>
          <Pagination page={page} total={q.data.pagination.total} pageSize={SURVEYS_PAGE_SIZE} onPage={setPage} label="evaluaciones" />
        </>
      )}
      <ConfirmDialog
        open={!!cancelling}
        title="¿Cancelar esta evaluación?"
        description={cancelling ? `${SURVEY_TYPE_LABEL[cancelling.type]} de ${cancelling.evaluatedUser.displayName}` : undefined}
        confirmLabel="Cancelar evaluación"
        loading={cancel.isPending}
        onClose={() => setCancelling(null)}
        onConfirm={() => cancelling && cancel.mutate(cancelling.id, { onSuccess: () => setCancelling(null) })}
      />
    </div>
  );
}

export default function PerformancePage() {
  const me = useAuth((s) => s.user);
  const tz = me?.timezone ?? 'America/Lima';
  const isManager = me?.role === 'ADMIN' || me?.role === 'JEFE_AREA';
  const [period, setPeriod] = useState(currentPeriod());
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Desempeño</h1>
          <p className="mt-1 text-sm text-muted">Autoevaluaciones, evaluaciones del jefe y resultados trimestrales.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/performance/reviews"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold transition hover:bg-sunken"
          >
            <Trophy className="size-4" aria-hidden /> Resultados
          </Link>
          {isManager && (
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
              Nueva evaluación
            </Button>
          )}
        </div>
      </div>

      <MySurveys tz={tz} />

      {isManager && (
        <section aria-labelledby="team" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="team" className="text-lg font-bold">
              {me?.role === 'ADMIN' ? 'Empresa' : 'Mi equipo'}
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Periodo</span>
              <Select className="w-36" value={period} onChange={(e) => setPeriod(e.target.value)}>
                {recentPeriods().map((p) => (
                  <option key={p} value={p}>
                    {periodLabel(p)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <TeamDashboard period={period} />
          <TeamSurveys period={period} tz={tz} />
        </section>
      )}

      {isManager && <CreateSurveyModal open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}
