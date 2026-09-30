import type { PerformanceRating, RiskLevel, SurveyQuestionType, SurveyType } from '@prisma/client';

// Pure scoring rules of the performance surveys. Every score is on a 0–100
// scale, rounded to one decimal, and `null` means "no data" — never 0, so a
// real zero is not confused with a missing metric.
//
// Three levels, from one answer up to one person's quarter:
//
//   performanceScore (per Survey)   weighted mean of the scored answers
//                                   (LIKERT_5, LIKERT_7, NUMERIC), each first
//                                   normalized to 0–100. TEXT and RANKING never
//                                   score, so a survey with only those has null.
//
//   Survey.dualScore (per Survey)   that ONE evaluation's two views, frozen when
//                                   the survey is completed:
//                                     productivity_index  Module 1, captured when the survey was created
//                                     performance_score   the answers above
//                                     overall_score       mean of the two that exist (one if the other is null)
//                                     status              rating of overall_score
//
//   PerformanceReview (per person   AGGREGATE of all that person's COMPLETED
//   and quarter)                    surveys of the period, recomputed every
//                                   time one of them completes:
//                                     overallDualScore = mean of their dualScore.overall_score
//                                     (e.g. 84, 86, 82 → 84), and likewise
//                                     overallPerformanceScore / overallProductivityIndex;
//                                     self-assessment and manager-review scores are
//                                     also kept apart so the dual view stays visible.
//
// The Survey rows are the source of truth; a review is always rebuildable from them.

export const SCORED_TYPES: readonly SurveyQuestionType[] = ['LIKERT_5', 'LIKERT_7', 'NUMERIC'];
export const isScored = (type: SurveyQuestionType) => SCORED_TYPES.includes(type);

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp100 = (n: number) => Math.min(100, Math.max(0, n));

export function mean(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return present.length ? round1(present.reduce((a, b) => a + b, 0) / present.length) : null;
}

// ─── Module 1: productivity ─────────────────────────────────────────────────

export interface PerformanceMetrics {
  completion_rate: number | null;
  on_time_rate: number | null;
  collaboration_score: number | null;
  kpi_achievement: number | null;
}

const PRODUCTIVITY_WEIGHTS: Record<keyof PerformanceMetrics, number> = {
  completion_rate: 0.3,
  on_time_rate: 0.3,
  collaboration_score: 0.2,
  kpi_achievement: 0.2,
};

// 30% completion + 30% on time + 20% collaboration + 20% KPIs. A metric with no
// data drops out and the others are re-weighted, so a person without KPIs is
// not punished with a zero; all of them missing → null.
export function calculateProductivityIndex(metrics: PerformanceMetrics): number | null {
  let total = 0;
  let weight = 0;
  for (const key of Object.keys(PRODUCTIVITY_WEIGHTS) as (keyof PerformanceMetrics)[]) {
    let value = metrics[key];
    if (value === null || !Number.isFinite(value)) continue;
    // Collaboration may arrive as points (max 200) instead of a percentage.
    if (key === 'collaboration_score' && value > 100) value = (value / 200) * 100;
    total += clamp100(value) * PRODUCTIVITY_WEIGHTS[key];
    weight += PRODUCTIVITY_WEIGHTS[key];
  }
  return weight > 0 ? round1(total / weight) : null;
}

// ─── Answers → performance score ────────────────────────────────────────────

// An answer on its question's own scale → 0–100; null for unscored types.
export function normalizeAnswer(type: SurveyQuestionType, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  switch (type) {
    case 'LIKERT_5':
      return clamp100(((value - 1) / 4) * 100);
    case 'LIKERT_7':
      return clamp100(((value - 1) / 6) * 100);
    case 'NUMERIC':
      return clamp100(value);
    default:
      return null;
  }
}

export interface ScorableQuestion {
  id: string;
  questionType: SurveyQuestionType;
  weight: number;
}

export function calculatePerformanceScore(
  questions: ScorableQuestion[],
  answers: { questionId: string; value: unknown }[],
): number | null {
  let total = 0;
  let weight = 0;
  for (const q of questions) {
    if (!isScored(q.questionType)) continue;
    const normalized = normalizeAnswer(q.questionType, answers.find((a) => a.questionId === q.id)?.value);
    if (normalized === null) continue;
    const w = q.weight > 0 ? q.weight : 1;
    total += normalized * w;
    weight += w;
  }
  return weight > 0 ? round1(total / weight) : null;
}

// ─── Dual score & rating ────────────────────────────────────────────────────

// Aligned with the area semaphore: 90+ green, 70–89 yellow, under 70 red.
export function ratingFor(score: number | null): PerformanceRating {
  if (score === null) return 'NOT_YET_RATED';
  if (score >= 90) return 'EXCEEDS_EXPECTATIONS';
  if (score >= 80) return 'MEETS_EXPECTATIONS';
  if (score >= 70) return 'DEVELOPING';
  return 'NEEDS_IMPROVEMENT';
}

export function riskFor(score: number | null): RiskLevel | null {
  if (score === null) return null;
  if (score >= 80) return 'LOW';
  if (score >= 70) return 'MEDIUM';
  return 'HIGH';
}

export interface DualScore {
  productivity_index: number | null;
  performance_score: number | null;
  overall_score: number | null;
  status: PerformanceRating;
}

export function calculateDualScore(productivityIndex: number | null, performanceScore: number | null): DualScore {
  const overall = mean([productivityIndex, performanceScore]);
  return {
    productivity_index: productivityIndex,
    performance_score: performanceScore,
    overall_score: overall,
    status: ratingFor(overall),
  };
}

// ─── Review aggregate ───────────────────────────────────────────────────────

export interface CompletedSurveyScores {
  type: SurveyType;
  productivityIndex: number | null;
  performanceScore: number | null;
  dualScore: unknown;
}

export function overallScoreOf(dualScore: unknown): number | null {
  const value = (dualScore as Partial<DualScore> | null)?.overall_score;
  return typeof value === 'number' ? value : null;
}

export function aggregateReview(surveys: CompletedSurveyScores[]) {
  const overallDualScore = mean(surveys.map((s) => overallScoreOf(s.dualScore)));
  return {
    surveysCompleted: surveys.length,
    selfAssessmentScore: mean(surveys.filter((s) => s.type === 'SELF_ASSESSMENT').map((s) => s.performanceScore)),
    managerReviewScore: mean(surveys.filter((s) => s.type === 'MANAGER_REVIEW').map((s) => s.performanceScore)),
    overallPerformanceScore: mean(surveys.map((s) => s.performanceScore)),
    overallProductivityIndex: mean(surveys.map((s) => s.productivityIndex)),
    overallDualScore,
    performanceRating: ratingFor(overallDualScore),
    riskLevel: riskFor(overallDualScore),
  };
}

// "2026-Q4" for the quarter containing a YYYY-MM-DD day.
export function reviewPeriodOf(day: string): string {
  const month = Number(day.slice(5, 7));
  return `${day.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}
