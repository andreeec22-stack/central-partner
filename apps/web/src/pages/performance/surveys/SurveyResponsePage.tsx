import clsx from 'clsx';
import { ArrowDown, ArrowLeft, ArrowUp, CircleAlert, Lock, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RatingBadge, Score, ScoreCard, SurveyStatusBadge, SURVEY_TYPE_LABEL } from '../../../components/performance/PerfBits';
import { Button } from '../../../components/ui/Button';
import { ErrorNotice, Spinner } from '../../../components/ui/Feedback';
import { Input, Textarea } from '../../../components/ui/Field';
import { ApiError } from '../../../lib/api';
import { formatDate, formatDateTime } from '../../../lib/format';
import { saveAnswers, useSubmitSurvey, useSurvey, type AnswerInput, type AnswerValue, type Question } from '../../../lib/performance';
import { useAutoSave, type AutoSaveStatus } from '../../../lib/useAutoSave';
import { useAuth } from '../../../stores/auth';
import { toast } from '../../../stores/toast';

const LIKERT_ENDS: Record<'LIKERT_5' | 'LIKERT_7', [string, string]> = {
  LIKERT_5: ['Muy bajo', 'Excelente'],
  LIKERT_7: ['Totalmente en desacuerdo', 'Totalmente de acuerdo'],
};

export function AutoSaveIndicator({ status, lastSavedAt, timeZone }: { status: AutoSaveStatus; lastSavedAt: Date | null; timeZone: string }) {
  const text =
    status === 'pending'
      ? 'Cambios sin guardar · se guardan solos cada 30 s'
      : status === 'saving'
        ? 'Guardando borrador…'
        : status === 'error'
          ? 'No se pudo guardar; lo reintentamos en 30 s'
          : lastSavedAt
            ? `Borrador guardado · ${formatDateTime(lastSavedAt.toISOString(), timeZone)}`
            : 'Tus respuestas se guardan automáticamente';
  return (
    <p role="status" aria-live="polite" className={clsx('text-xs font-medium', status === 'error' ? 'text-sem-red' : 'text-muted')}>
      {text}
    </p>
  );
}

function QuestionInput({ q, value, disabled, onChange }: { q: Question; value: AnswerValue | undefined; disabled: boolean; onChange: (v: AnswerValue | null) => void }) {
  if (q.questionType === 'LIKERT_5' || q.questionType === 'LIKERT_7') {
    const max = q.questionType === 'LIKERT_5' ? 5 : 7;
    const [low, high] = LIKERT_ENDS[q.questionType];
    return (
      <div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <label
              key={n}
              className={clsx(
                'grid size-10 cursor-pointer place-items-center rounded-lg border text-sm font-bold transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40',
                value === n ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface hover:bg-sunken',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input type="radio" className="sr-only" name={q.id} value={n} checked={value === n} disabled={disabled} onChange={() => onChange(n)} />
              {n}
            </label>
          ))}
        </div>
        <p className="mt-1.5 flex justify-between text-xs text-muted" style={{ maxWidth: `${max * 3}rem` }}>
          <span>{low}</span>
          <span>{high}</span>
        </p>
      </div>
    );
  }
  if (q.questionType === 'NUMERIC') {
    return (
      <Input
        type="number"
        min={0}
        max={100}
        inputMode="decimal"
        className="w-32"
        aria-label={`${q.text} (0 a 100)`}
        disabled={disabled}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => {
          const n = e.target.value === '' ? null : Number(e.target.value);
          onChange(n === null || Number.isNaN(n) ? null : Math.min(100, Math.max(0, n)));
        }}
      />
    );
  }
  if (q.questionType === 'TEXT') {
    return (
      <Textarea
        aria-label={q.text}
        disabled={disabled}
        maxLength={4000}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
      />
    );
  }
  // RANKING: nothing is saved until the person orders (or accepts) the list.
  const order = Array.isArray(value) ? value : q.options;
  const move = (i: number, dir: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {order.map((opt, i) => (
          <li key={opt} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <span className="tabular w-5 font-bold text-muted">{i + 1}.</span>
            <span className="flex-1">{opt}</span>
            <button type="button" className="rounded p-1 text-muted hover:bg-sunken disabled:opacity-30" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label={`Subir ${opt}`}>
              <ArrowUp className="size-4" />
            </button>
            <button type="button" className="rounded p-1 text-muted hover:bg-sunken disabled:opacity-30" disabled={disabled || i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Bajar ${opt}`}>
              <ArrowDown className="size-4" />
            </button>
          </li>
        ))}
      </ol>
      {!Array.isArray(value) && !disabled && (
        <Button size="sm" variant="secondary" onClick={() => onChange([...q.options])}>
          Usar este orden
        </Button>
      )}
    </div>
  );
}

export default function SurveyResponsePage() {
  const { surveyId = '' } = useParams();
  const me = useAuth((s) => s.user);
  const tz = me?.timezone ?? 'America/Lima';
  const survey = useSurvey(surveyId);
  const submit = useSubmitSurvey(surveyId);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const autoSave = useAutoSave<AnswerInput>((changes) => saveAnswers(surveyId, changes), (c) => c.questionId);

  // Seed the form once; later refetches must not clobber what is being typed.
  useEffect(() => {
    if (!survey.data || loaded) return;
    setAnswers(Object.fromEntries(survey.data.responses.map((r) => [r.questionId, r.value])));
    setLoaded(true);
  }, [survey.data, loaded]);

  const s = survey.data;
  const editable = !!s?.permissions.canAnswer;
  const answered = useMemo(() => (s ? s.questions.filter((q) => answers[q.id] !== undefined).length : 0), [s, answers]);

  if (survey.isPending) return <Spinner className="py-16" />;
  if (survey.isError || !s) {
    const status = survey.error instanceof ApiError ? survey.error.status : 0;
    return <ErrorNotice message={status === 403 || status === 404 ? 'Esta encuesta no existe o no tienes acceso a ella.' : 'No se pudo cargar la encuesta.'} onRetry={() => void survey.refetch()} />;
  }

  function change(questionId: string, value: AnswerValue | null) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === null) delete next[questionId];
      else next[questionId] = value;
      return next;
    });
    setMissing((m) => {
      if (!m.has(questionId)) return m;
      const next = new Set(m);
      next.delete(questionId);
      return next;
    });
    autoSave.queue({ questionId, value });
  }

  async function send() {
    if (!(await autoSave.flush())) {
      toast.error('No se pudieron guardar tus respuestas; revisa tu conexión');
      return;
    }
    try {
      await submit.mutateAsync();
      toast.success('Encuesta enviada');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SURVEY_INCOMPLETE') {
        setMissing(new Set((e.details as { missingQuestionIds: string[] }).missingQuestionIds));
        toast.error(e.message);
      } else toast.error(e instanceof ApiError ? e.message : 'No se pudo enviar la encuesta');
    }
  }

  const lockedReason = !editable
    ? s.status === 'COMPLETED'
      ? 'Enviada: ya no se puede editar.'
      : s.status === 'CANCELLED'
        ? 'Esta encuesta fue cancelada.'
        : s.status === 'SCHEDULED'
          ? `Se abre el ${formatDate(s.startDate, tz)}.`
          : s.isOverdue
            ? 'La fecha límite ya pasó.'
            : 'Solo lectura.'
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/performance" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Desempeño
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SurveyStatusBadge status={s.status} overdue={s.isOverdue} />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{SURVEY_TYPE_LABEL[s.type]}</span>
        </div>
        <h1 className="text-2xl font-extrabold tracking-tight">{s.title}</h1>
        <p className="text-sm text-muted">
          {s.type === 'SELF_ASSESSMENT' ? 'Sobre ti' : `Sobre ${s.evaluatedUser.displayName}`} · {s.department.name} · vence el {formatDate(s.endDate, tz)}
        </p>
        {s.description && <p className="text-sm text-ink-soft">{s.description}</p>}
      </header>

      {s.status === 'COMPLETED' && (
        <section aria-label="Resultado" className="grid gap-3 sm:grid-cols-3">
          <ScoreCard label="Puntaje de la encuesta" value={s.performanceScore} hint="Respuestas con escala o número" />
          <ScoreCard label="Índice de productividad" value={s.productivityIndex} hint="Tareas y KPIs al crear la encuesta" />
          <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Puntaje combinado</p>
            <Score value={s.dualScore?.overall_score ?? null} className="mt-1 block text-2xl" />
            {s.dualScore && (
              <div className="mt-1">
                <RatingBadge rating={s.dualScore.status} />
              </div>
            )}
          </div>
        </section>
      )}

      {lockedReason && (
        <p className="flex items-center gap-2 rounded-lg bg-sunken px-3 py-2 text-sm text-ink-soft">
          <Lock className="size-4" aria-hidden /> {lockedReason}
        </p>
      )}

      <ol className="space-y-4">
        {s.questions.map((q) => (
          <li key={q.id}>
            <fieldset className={clsx('rounded-2xl border bg-surface p-5 shadow-card', missing.has(q.id) ? 'border-sem-red' : 'border-line')}>
              <legend className="sr-only">{q.text}</legend>
              <p className="mb-3 font-semibold" aria-hidden>
                <span className="tabular mr-2 text-muted">{q.questionNumber}.</span>
                {q.text}
                {!q.required && <span className="ml-2 text-xs font-normal text-muted">(opcional)</span>}
              </p>
              <QuestionInput q={q} value={answers[q.id]} disabled={!editable} onChange={(v) => change(q.id, v)} />
              {missing.has(q.id) && (
                <p className="mt-2 flex items-center gap-1 text-xs font-medium text-sem-red">
                  <CircleAlert className="size-3.5" aria-hidden /> Responde esta pregunta para enviar
                </p>
              )}
            </fieldset>
          </li>
        ))}
      </ol>

      {editable && (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper/90 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border">
          <div>
            <p className="text-sm font-semibold">
              {answered} de {s.questions.length} respondidas
            </p>
            <AutoSaveIndicator status={autoSave.status} lastSavedAt={autoSave.lastSavedAt} timeZone={tz} />
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void autoSave.flush()} disabled={autoSave.status === 'saving'}>
              Guardar borrador
            </Button>
            <Button icon={<Send className="size-4" aria-hidden />} loading={submit.isPending} onClick={() => void send()}>
              Enviar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
