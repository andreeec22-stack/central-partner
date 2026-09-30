import clsx from 'clsx';
import type { ReactNode } from 'react';
import { formatPercent } from '../../lib/format';
import type { PerformanceRating, QuestionType, SurveyStatus, SurveyType } from '../../lib/performance';

// Labels and small badges shared by the performance pages.

export const SURVEY_TYPE_LABEL: Record<SurveyType, string> = {
  SELF_ASSESSMENT: 'Autoevaluación',
  MANAGER_REVIEW: 'Evaluación del jefe',
};

export const SURVEY_STATUS_LABEL: Record<SurveyStatus, string> = {
  SCHEDULED: 'Programada',
  ACTIVE: 'Abierta',
  COMPLETED: 'Enviada',
  CANCELLED: 'Cancelada',
};

export const RATING_LABEL: Record<PerformanceRating, string> = {
  EXCEEDS_EXPECTATIONS: 'Supera expectativas',
  MEETS_EXPECTATIONS: 'Cumple expectativas',
  DEVELOPING: 'En desarrollo',
  NEEDS_IMPROVEMENT: 'Necesita mejorar',
  NOT_YET_RATED: 'Sin calificar',
};

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  LIKERT_5: 'Escala 1–5',
  LIKERT_7: 'Escala 1–7',
  NUMERIC: 'Número 0–100',
  TEXT: 'Texto libre',
  RANKING: 'Ordenar opciones',
};

const statusTone: Record<SurveyStatus, string> = {
  SCHEDULED: 'bg-sunken text-ink-soft',
  ACTIVE: 'bg-brand/10 text-brand',
  COMPLETED: 'bg-sem-green-soft text-sem-green',
  CANCELLED: 'bg-paper text-muted ring-1 ring-line',
};

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', tone)}>{children}</span>;
}

export function SurveyStatusBadge({ status, overdue }: { status: SurveyStatus; overdue?: boolean }) {
  if (overdue) return <Pill tone="bg-sem-red-soft text-sem-red">Vencida</Pill>;
  return <Pill tone={statusTone[status]}>{SURVEY_STATUS_LABEL[status]}</Pill>;
}

const ratingTone: Record<PerformanceRating, string> = {
  EXCEEDS_EXPECTATIONS: 'bg-sem-green-soft text-sem-green',
  MEETS_EXPECTATIONS: 'bg-sem-green-soft text-sem-green',
  DEVELOPING: 'bg-sem-yellow-soft text-ink',
  NEEDS_IMPROVEMENT: 'bg-sem-red-soft text-sem-red',
  NOT_YET_RATED: 'bg-sunken text-muted',
};

export function RatingBadge({ rating }: { rating: PerformanceRating }) {
  return <Pill tone={ratingTone[rating]}>{RATING_LABEL[rating]}</Pill>;
}

// A 0–100 score, colored like the semaphore (90+ / 70–89 / under 70).
export function Score({ value, className }: { value: number | null; className?: string }) {
  const tone = value === null ? 'text-muted' : value >= 90 ? 'text-sem-green' : value >= 70 ? 'text-ink' : 'text-sem-red';
  return <span className={clsx('tabular font-bold', tone, className)}>{value === null ? '—' : formatPercent(value)}</span>;
}

export function ScoreCard({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <Score value={value} className="mt-1 block text-2xl" />
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

// The last quarters, newest first.
export function recentPeriods(count = 6, now = new Date()): string[] {
  const out: string[] = [];
  let year = now.getFullYear();
  let quarter = Math.floor(now.getMonth() / 3) + 1;
  for (let i = 0; i < count; i++) {
    out.push(`${year}-Q${quarter}`);
    quarter--;
    if (quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return out;
}

export const periodLabel = (p: string) => p.replace('-Q', ' · T');
