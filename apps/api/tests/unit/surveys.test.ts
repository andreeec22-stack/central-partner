import type { Survey } from '@prisma/client';
import { AppError } from '../../src/lib/errors';
import {
  aggregateReview,
  calculateDualScore,
  calculatePerformanceScore,
  calculateProductivityIndex,
  normalizeAnswer,
  ratingFor,
  reviewPeriodOf,
  riskFor,
} from '../../src/modules/surveys/scoring';
import { checkReviewAccess, checkSurveyAccess, canManageEvaluationsOf } from '../../src/modules/surveys/surveys.access';
import {
  validateAnswerValue,
  validateCreateSurveyData,
  validateSurveyCompletion,
  validateTemplateQuestions,
  validateTemplateStatus,
  validateUserExists,
} from '../../src/modules/surveys/surveys.validators';
import { withTimeout } from '../../src/modules/surveys/surveys.service';
import type { AuthUser } from '../../src/types';

const q = (questionType: any, extra: Record<string, unknown> = {}) => ({ text: 'Pregunta', questionType, weight: 1, required: true, options: [], ...extra });

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected an error');
}

describe('calculateProductivityIndex (Module 1)', () => {
  it('weights completion 30 / on time 30 / collaboration 20 / KPIs 20', () => {
    expect(calculateProductivityIndex({ completion_rate: 80, on_time_rate: 90, collaboration_score: 70, kpi_achievement: 100 })).toBe(85);
  });

  it('re-weights over the metrics that exist instead of counting missing ones as 0', () => {
    // (80·0.3 + 90·0.3 + 100·0.2) / 0.8
    expect(calculateProductivityIndex({ completion_rate: 80, on_time_rate: 90, collaboration_score: null, kpi_achievement: 100 })).toBe(88.8);
    expect(calculateProductivityIndex({ completion_rate: 0, on_time_rate: null, collaboration_score: null, kpi_achievement: null })).toBe(0);
    expect(calculateProductivityIndex({ completion_rate: null, on_time_rate: null, collaboration_score: null, kpi_achievement: null })).toBeNull();
  });

  it('normalizes collaboration given as points (max 200) and clamps to 0–100', () => {
    expect(calculateProductivityIndex({ completion_rate: null, on_time_rate: null, collaboration_score: 150, kpi_achievement: null })).toBe(75);
    expect(calculateProductivityIndex({ completion_rate: 130, on_time_rate: null, collaboration_score: null, kpi_achievement: null })).toBe(100);
  });
});

describe('calculatePerformanceScore', () => {
  const questions = [
    { id: 'l5', questionType: 'LIKERT_5' as const, weight: 1 },
    { id: 'l7', questionType: 'LIKERT_7' as const, weight: 2 },
    { id: 'num', questionType: 'NUMERIC' as const, weight: 1 },
    { id: 'txt', questionType: 'TEXT' as const, weight: 5 },
    { id: 'rank', questionType: 'RANKING' as const, weight: 5 },
  ];

  it('normalizes each scale to 0–100', () => {
    expect([1, 3, 5].map((v) => normalizeAnswer('LIKERT_5', v))).toEqual([0, 50, 100]);
    expect([1, 4, 7].map((v) => normalizeAnswer('LIKERT_7', v))).toEqual([0, 50, 100]);
    expect(normalizeAnswer('NUMERIC', 72)).toBe(72);
    expect(normalizeAnswer('TEXT', 'bien')).toBeNull();
  });

  it('is the weighted mean of the scored answers; text and ranking never count', () => {
    const score = calculatePerformanceScore(questions, [
      { questionId: 'l5', value: 4 }, // 75 ×1
      { questionId: 'l7', value: 7 }, // 100 ×2
      { questionId: 'num', value: 60 }, // 60 ×1
      { questionId: 'txt', value: 'excelente' },
      { questionId: 'rank', value: ['a', 'b'] },
    ]);
    expect(score).toBe(83.8); // (75 + 200 + 60) / 4
  });

  it('is null when only TEXT/RANKING were answered', () => {
    expect(calculatePerformanceScore(questions, [{ questionId: 'txt', value: 'hola' }])).toBeNull();
    expect(calculatePerformanceScore([{ id: 'txt', questionType: 'TEXT', weight: 1 }], [{ questionId: 'txt', value: 'x' }])).toBeNull();
  });
});

describe('dual score, rating and review aggregate', () => {
  it('averages the views that exist, and a real 0 is not "missing"', () => {
    expect(calculateDualScore(80, 90)).toEqual({ productivity_index: 80, performance_score: 90, overall_score: 85, status: 'MEETS_EXPECTATIONS' });
    expect(calculateDualScore(null, 72).overall_score).toBe(72);
    expect(calculateDualScore(0, 80).overall_score).toBe(40);
    expect(calculateDualScore(null, null)).toMatchObject({ overall_score: null, status: 'NOT_YET_RATED' });
  });

  it('rates in order, aligned with the 90 / 70 semaphore', () => {
    expect([95, 90, 85, 75, 69.9, 40, 0].map(ratingFor)).toEqual([
      'EXCEEDS_EXPECTATIONS',
      'EXCEEDS_EXPECTATIONS',
      'MEETS_EXPECTATIONS',
      'DEVELOPING',
      'NEEDS_IMPROVEMENT',
      'NEEDS_IMPROVEMENT',
      'NEEDS_IMPROVEMENT',
    ]);
    expect(ratingFor(null)).toBe('NOT_YET_RATED');
    expect([85, 75, 50, null].map(riskFor)).toEqual(['LOW', 'MEDIUM', 'HIGH', null]);
  });

  it('review overallDualScore = mean of the surveys’ overall scores (84, 86, 82 → 84)', () => {
    const s = (type: 'SELF_ASSESSMENT' | 'MANAGER_REVIEW', perf: number | null, prod: number | null, overall: number | null) => ({
      type,
      performanceScore: perf,
      productivityIndex: prod,
      dualScore: { overall_score: overall },
    });
    const review = aggregateReview([s('SELF_ASSESSMENT', 90, 78, 84), s('MANAGER_REVIEW', 94, 78, 86), s('MANAGER_REVIEW', 86, 78, 82)]);
    expect(review).toMatchObject({
      surveysCompleted: 3,
      overallDualScore: 84,
      selfAssessmentScore: 90,
      managerReviewScore: 90,
      overallProductivityIndex: 78,
      performanceRating: 'MEETS_EXPECTATIONS',
      riskLevel: 'LOW',
    });
  });

  it('periods are calendar quarters', () => {
    expect(['2026-01-01', '2026-03-31', '2026-09-30', '2026-10-01', '2026-12-31'].map(reviewPeriodOf)).toEqual([
      '2026-Q1',
      '2026-Q1',
      '2026-Q3',
      '2026-Q4',
      '2026-Q4',
    ]);
  });
});

describe('survey validators (Risk 3 + 5)', () => {
  it('templates need 3+ questions and at least one scored one', () => {
    expect(errorOf(() => validateTemplateQuestions([q('LIKERT_5'), q('TEXT')])).status).toBe(422);
    const noScore = errorOf(() => validateTemplateQuestions([q('TEXT'), q('TEXT'), q('RANKING', { options: ['a', 'b'] })]));
    expect(JSON.stringify(noScore.details)).toContain('LIKERT_5');
    expect(() => validateTemplateQuestions([q('LIKERT_5'), q('TEXT'), q('NUMERIC')])).not.toThrow();
  });

  it('checks ranking options', () => {
    expect(errorOf(() => validateTemplateQuestions([q('LIKERT_5'), q('TEXT'), q('RANKING', { options: ['a'] })])).status).toBe(422);
    expect(errorOf(() => validateTemplateQuestions([q('LIKERT_5'), q('TEXT'), q('RANKING', { options: ['a', 'A'] })])).status).toBe(422);
    expect(errorOf(() => validateTemplateQuestions([q('LIKERT_5', { options: ['x'] }), q('TEXT'), q('NUMERIC')])).status).toBe(422);
  });

  it('survey dates: start before end, end not in the past', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(() => validateCreateSurveyData({ startDate: new Date('2026-10-01'), endDate: new Date('2026-10-15') }, now)).not.toThrow();
    expect(errorOf(() => validateCreateSurveyData({ startDate: new Date('2026-10-15'), endDate: new Date('2026-10-01') }, now)).status).toBe(422);
    expect(errorOf(() => validateCreateSurveyData({ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-15') }, now)).status).toBe(422);
  });

  it('template must exist and be ACTIVE; user must belong to the workspace', () => {
    expect(errorOf(() => validateTemplateStatus(null)).status).toBe(404);
    expect(errorOf(() => validateTemplateStatus({ status: 'DRAFT' })).status).toBe(422);
    expect(() => validateTemplateStatus({ status: 'ACTIVE' })).not.toThrow();
    expect(errorOf(() => validateUserExists({ workspaceId: 'other', deletedAt: null, departmentId: null }, 'ws')).status).toBe(422);
    expect(errorOf(() => validateUserExists({ workspaceId: 'ws', deletedAt: new Date(), departmentId: null }, 'ws')).status).toBe(422);
  });

  it('completion needs every required question', () => {
    const questions = [
      { id: 'a', required: true },
      { id: 'b', required: false },
    ];
    expect(() => validateSurveyCompletion(questions, new Set(['a']))).not.toThrow();
    const err = errorOf(() => validateSurveyCompletion(questions, new Set(['b'])));
    expect(err.code).toBe('SURVEY_INCOMPLETE');
    expect(err.details).toEqual({ missingQuestionIds: ['a'] });
  });

  it('answers must fit the question type', () => {
    const rank = { questionType: 'RANKING' as const, options: ['a', 'b', 'c'] };
    expect(validateAnswerValue({ questionType: 'LIKERT_5', options: [] }, 5)).toBeNull();
    expect(validateAnswerValue({ questionType: 'LIKERT_5', options: [] }, 6)).not.toBeNull();
    expect(validateAnswerValue({ questionType: 'LIKERT_7', options: [] }, 3.5)).not.toBeNull();
    expect(validateAnswerValue({ questionType: 'NUMERIC', options: [] }, 101)).not.toBeNull();
    expect(validateAnswerValue({ questionType: 'TEXT', options: [] }, '  ')).not.toBeNull();
    expect(validateAnswerValue(rank, ['c', 'a', 'b'])).toBeNull();
    expect(validateAnswerValue(rank, ['a', 'a', 'b'])).not.toBeNull();
  });
});

describe('survey access (Risk 1)', () => {
  const user = (role: AuthUser['role'], id: string, departmentId: string | null): AuthUser => ({
    id,
    role,
    departmentId,
    workspaceId: 'ws',
    sessionId: 's',
    canCreateTasks: false,
    email: `${id}@x`,
    displayName: id,
    timezone: 'UTC',
    workspaceTimezone: 'America/Lima',
  });
  type Ref = Parameters<typeof checkSurveyAccess>[1];
  const survey = (over: Partial<Survey> = {}, evaluatedRole: AuthUser['role'] = 'USER') =>
    ({ evaluatorId: 'jefe', evaluatedUserId: 'ana', departmentId: 'mkt', type: 'MANAGER_REVIEW', status: 'ACTIVE', ...over, evaluatedUser: { role: evaluatedRole } }) as Ref;

  it('ADMIN sees everything, VIEWER nothing', () => {
    expect(checkSurveyAccess(user('ADMIN', 'dir', null), survey())).toBe(true);
    expect(checkSurveyAccess(user('VIEWER', 'lector', 'mkt'), survey())).toBe(false);
  });

  it('JEFE_AREA sees their department and what they must fill, not other areas', () => {
    expect(checkSurveyAccess(user('JEFE_AREA', 'otro-jefe', 'mkt'), survey())).toBe(true);
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe-fin', 'fin'), survey())).toBe(false);
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe', 'fin'), survey())).toBe(true); // evaluator
  });

  it('nobody but the director sees evaluations about themselves before publication', () => {
    const aboutJefe = survey({ evaluatorId: 'dir', evaluatedUserId: 'jefe', status: 'COMPLETED' }, 'JEFE_AREA');
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe', 'mkt'), aboutJefe)).toBe(false);
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe', 'mkt'), aboutJefe, true)).toBe(true);
  });

  it('USER sees what they fill, and the manager review about them only once published', () => {
    expect(checkSurveyAccess(user('USER', 'ana', 'mkt'), survey({ type: 'SELF_ASSESSMENT', evaluatorId: 'ana' }))).toBe(true);
    expect(checkSurveyAccess(user('USER', 'ana', 'mkt'), survey({ status: 'COMPLETED' }))).toBe(false);
    expect(checkSurveyAccess(user('USER', 'ana', 'mkt'), survey({ status: 'COMPLETED' }), true)).toBe(true);
    expect(checkSurveyAccess(user('USER', 'ana', 'mkt'), survey({ status: 'ACTIVE' }), true)).toBe(false);
    expect(checkSurveyAccess(user('USER', 'luis', 'mkt'), survey({ type: 'SELF_ASSESSMENT', evaluatorId: 'ana' }))).toBe(false);
  });

  it('CR-01: a JEFE_AREA never sees evaluations about a peer head of the same area', () => {
    const aboutPeer = survey({ evaluatorId: 'dir', evaluatedUserId: 'jefe-b', status: 'COMPLETED' }, 'JEFE_AREA');
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe-a', 'mkt'), aboutPeer)).toBe(false);
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe-a', 'mkt'), aboutPeer, true)).toBe(false);
    expect(checkSurveyAccess(user('ADMIN', 'dir', null), aboutPeer)).toBe(true);
    // …but still sees the team, VIEWERs included.
    expect(checkSurveyAccess(user('JEFE_AREA', 'jefe-a', 'mkt'), survey({ evaluatorId: 'dir' }, 'VIEWER'))).toBe(true);
    expect(canManageEvaluationsOf(user('JEFE_AREA', 'jefe-a', 'mkt'), { id: 'jefe-b', departmentId: 'mkt', role: 'JEFE_AREA' })).toBe(false);
    expect(checkReviewAccess(user('JEFE_AREA', 'jefe-a', 'mkt'), { userId: 'jefe-b', departmentId: 'mkt', publishedAt: null, user: { role: 'JEFE_AREA' } })).toBe(false);
  });

  it('managing evaluations: ADMIN anyone, JEFE their own department except themselves', () => {
    expect(canManageEvaluationsOf(user('ADMIN', 'dir', null), { id: 'x', departmentId: 'fin', role: 'JEFE_AREA' })).toBe(true);
    expect(canManageEvaluationsOf(user('JEFE_AREA', 'jefe', 'mkt'), { id: 'ana', departmentId: 'mkt', role: 'USER' })).toBe(true);
    expect(canManageEvaluationsOf(user('JEFE_AREA', 'jefe', 'mkt'), { id: 'jefe', departmentId: 'mkt', role: 'JEFE_AREA' })).toBe(false);
    expect(canManageEvaluationsOf(user('JEFE_AREA', 'jefe', 'mkt'), { id: 'carla', departmentId: 'fin', role: 'USER' })).toBe(false);
    expect(canManageEvaluationsOf(user('USER', 'ana', 'mkt'), { id: 'luis', departmentId: 'mkt', role: 'USER' })).toBe(false);
  });

  it('reviews: the subject only once published', () => {
    const review = { userId: 'ana', departmentId: 'mkt', publishedAt: null as Date | null, user: { role: 'USER' as const } };
    expect(checkReviewAccess(user('USER', 'ana', 'mkt'), review)).toBe(false);
    expect(checkReviewAccess(user('USER', 'ana', 'mkt'), { ...review, publishedAt: new Date() })).toBe(true);
    expect(checkReviewAccess(user('JEFE_AREA', 'jefe', 'mkt'), review)).toBe(true);
    expect(checkReviewAccess(user('JEFE_AREA', 'jefe-fin', 'fin'), review)).toBe(false);
  });
});

describe('withTimeout (Risk 2)', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects after the limit and passes results through before it', async () => {
    jest.useFakeTimers();
    const never = withTimeout(new Promise(() => undefined), 3000);
    const assertion = expect(never).rejects.toThrow('Timed out after 3000 ms');
    jest.advanceTimersByTime(3000);
    await assertion;
    await expect(withTimeout(Promise.resolve(42), 3000)).resolves.toBe(42);
  });
});
