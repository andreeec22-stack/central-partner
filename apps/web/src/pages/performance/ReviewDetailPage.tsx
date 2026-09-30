import { ArrowLeft, Megaphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ConfirmDialog } from '../../components/admin/AdminKit';
import { periodLabel, RatingBadge, Score, ScoreCard, SurveyStatusBadge, SURVEY_TYPE_LABEL } from '../../components/performance/PerfBits';
import { Button } from '../../components/ui/Button';
import { ErrorNotice, Spinner } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { ApiError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { usePublishReview, useReview, useUpdateReview, type PerformanceReview } from '../../lib/performance';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const RISK_LABEL = { LOW: 'Bajo', MEDIUM: 'Medio', HIGH: 'Alto' } as const;

function ManagerForm({ review }: { review: PerformanceReview }) {
  const update = useUpdateReview(review.id);
  const [comments, setComments] = useState(review.managerComments ?? '');
  const [strengths, setStrengths] = useState(review.strengths.join('\n'));
  const [improve, setImprove] = useState(review.areasForImprovement.join('\n'));
  const [goals, setGoals] = useState(review.developmentGoals.join('\n'));
  const [next, setNext] = useState(review.nextReviewDate ?? '');

  return (
    <form
      className="space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-card"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          {
            managerComments: comments.trim() || null,
            strengths: lines(strengths),
            areasForImprovement: lines(improve),
            developmentGoals: lines(goals),
            nextReviewDate: next || null,
          },
          { onSuccess: () => toast.success('Cambios guardados') },
        );
      }}
    >
      <h2 className="font-bold">Retroalimentación del jefe</h2>
      <Field label="Comentarios">{(id) => <Textarea id={id} maxLength={4000} value={comments} onChange={(e) => setComments(e.target.value)} />}</Field>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Fortalezas" hint="Una por línea">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={strengths} onChange={(e) => setStrengths(e.target.value)} />}
        </Field>
        <Field label="Oportunidades de mejora" hint="Una por línea">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={improve} onChange={(e) => setImprove(e.target.value)} />}
        </Field>
        <Field label="Metas de desarrollo" hint="Una por línea">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={goals} onChange={(e) => setGoals(e.target.value)} />}
        </Field>
      </div>
      <Field label="Próxima revisión">{(id) => <Input id={id} type="date" className="w-48" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
      <div className="flex justify-end">
        <Button type="submit" loading={update.isPending}>
          Guardar
        </Button>
      </div>
    </form>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-sm font-bold">{title}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function EmployeeComment({ review }: { review: PerformanceReview }) {
  const update = useUpdateReview(review.id);
  const [text, setText] = useState(review.employeeComments ?? '');
  return (
    <div className="space-y-2">
      <Field label="Tus comentarios">{(id) => <Textarea id={id} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      <div className="flex justify-end">
        <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ employeeComments: text.trim() || null }, { onSuccess: () => toast.success('Comentario guardado') })}>
          Guardar comentario
        </Button>
      </div>
    </div>
  );
}

export default function ReviewDetailPage() {
  const { reviewId = '' } = useParams();
  const tz = useAuth((s) => s.user?.timezone) ?? 'America/Lima';
  const q = useReview(reviewId);
  const publish = usePublishReview(reviewId);
  const [confirm, setConfirm] = useState(false);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => setFormKey((k) => k + 1), [q.data?.review.updatedAt]);

  if (q.isPending) return <Spinner className="py-16" />;
  if (q.isError) {
    const status = q.error instanceof ApiError ? q.error.status : 0;
    return <ErrorNotice message={status === 403 || status === 404 ? 'Este resultado no existe o aún no está publicado.' : 'No se pudo cargar el resultado.'} onRetry={() => void q.refetch()} />;
  }
  const { review: r, surveys } = q.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/performance/reviews" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Resultados
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted">
            {periodLabel(r.reviewPeriod)} · {r.department?.name ?? 'Sin área'}
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">{r.user.displayName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <RatingBadge rating={r.performanceRating} />
            {r.riskLevel && <span className="text-xs font-semibold text-muted">Riesgo {RISK_LABEL[r.riskLevel].toLowerCase()}</span>}
            <span className="text-xs text-muted">{r.publishedAt ? `Publicado el ${formatDate(r.publishedAt, tz)}` : 'Borrador: la persona aún no lo ve'}</span>
          </div>
        </div>
        {r.permissions.canPublish && (
          <Button icon={<Megaphone className="size-4" aria-hidden />} onClick={() => setConfirm(true)}>
            Publicar a {r.user.displayName}
          </Button>
        )}
      </div>

      <section aria-label="Puntajes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <ScoreCard label="Combinado" value={r.overallDualScore} hint="Promedio de las evaluaciones" />
        <ScoreCard label="Autoevaluación" value={r.selfAssessmentScore} />
        <ScoreCard label="Evaluación del jefe" value={r.managerReviewScore} />
        <ScoreCard label="Encuestas" value={r.overallPerformanceScore} hint={`${r.surveysCompleted} de ${r.surveysInitiated} enviadas`} />
        <ScoreCard label="Productividad" value={r.overallProductivityIndex} hint="Tareas a tiempo y KPIs" />
      </section>

      <section aria-labelledby="evals" className="rounded-2xl border border-line bg-surface p-5 shadow-card">
        <h2 id="evals" className="font-bold">
          Evaluaciones del periodo
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {surveys.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <span>
                <Link to={`/performance/surveys/${s.id}`} className="font-semibold hover:underline">
                  {SURVEY_TYPE_LABEL[s.type]}
                </Link>{' '}
                <span className="text-muted">· {s.evaluator.displayName}</span>
              </span>
              <span className="flex items-center gap-3">
                <SurveyStatusBadge status={s.status} />
                <Score value={s.dualScore?.overall_score ?? null} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      {r.permissions.canEdit ? (
        <ManagerForm key={formKey} review={r} />
      ) : (
        (r.managerComments || r.strengths.length > 0 || r.areasForImprovement.length > 0 || r.developmentGoals.length > 0) && (
          <section className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
            <h2 className="font-bold">Retroalimentación</h2>
            {r.managerComments && <p className="whitespace-pre-line text-sm text-ink-soft">{r.managerComments}</p>}
            <div className="grid gap-4 md:grid-cols-3">
              <ListBlock title="Fortalezas" items={r.strengths} />
              <ListBlock title="Oportunidades de mejora" items={r.areasForImprovement} />
              <ListBlock title="Metas de desarrollo" items={r.developmentGoals} />
            </div>
            {r.nextReviewDate && <p className="text-xs text-muted">Próxima revisión: {r.nextReviewDate}</p>}
          </section>
        )
      )}

      {(r.permissions.canComment || r.employeeComments) && (
        <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          {r.permissions.canComment ? (
            <EmployeeComment review={r} />
          ) : (
            <>
              <h2 className="font-bold">Comentarios de {r.user.displayName}</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{r.employeeComments}</p>
            </>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        danger={false}
        title={`¿Publicar el resultado a ${r.user.displayName}?`}
        description="Verá sus puntajes, la evaluación de su jefe y la retroalimentación."
        confirmLabel="Publicar"
        loading={publish.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => publish.mutate(undefined, { onSuccess: () => (setConfirm(false), toast.success('Resultado publicado')) })}
      />
    </div>
  );
}
