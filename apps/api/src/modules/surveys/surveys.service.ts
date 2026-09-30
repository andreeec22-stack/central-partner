import type { Prisma, Survey, SurveyStatus, SurveyType } from '@prisma/client';
import { AppError, conflict, forbidden, notFound, validationError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { toSkipTake } from '../../lib/pagination';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { localDay } from '../../lib/week';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { notifySafely } from '../notifications/notify.service';
import * as perf from '../performance/performance.service';
import { upsertPerformanceReview } from './reviews.service';
import { calculateDualScore, calculatePerformanceScore, reviewPeriodOf } from './scoring';
import { canManageEvaluationsOf, checkSurveyAccess, surveyVisibilityFilter } from './surveys.access';
import { invalidateSurveyDashboards } from './surveys.dashboard';
import type { CreateSurveyInput, ListSurveysQuery, SaveResponsesInput } from './surveys.schemas';
import {
  validateAnswerValue,
  validateCreateSurveyData,
  validateSurveyCompletion,
  validateTemplateStatus,
  validateUserExists,
} from './surveys.validators';

// A Survey is one evaluation of one person (the evaluated) filled by one
// evaluator: themselves (SELF_ASSESSMENT) or a manager (MANAGER_REVIEW).
//
//   SCHEDULED ──startDate──▶ ACTIVE ──submit──▶ COMPLETED
//        └──────────── cancel ───────────┴──▶ CANCELLED
//
// Answers are saved as drafts (the web app auto-saves every 30 s) until the
// evaluator submits; then the survey is locked (Risk 7). Scores: scoring.ts.

export const TYPE_LABEL: Record<SurveyType, string> = { SELF_ASSESSMENT: 'Autoevaluación', MANAGER_REVIEW: 'Evaluación del jefe' };

// Mutable so tests can shorten the Module 1 timeout.
export const surveyConfig = { productivityTimeoutMs: 3000 };

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Risk 2: Module 1 must never block creating a survey. Any failure, a timeout
// or simply no data → productivityIndex = null, and the survey is created anyway.
export async function captureProductivity(workspaceId: string, userId: string, timeZone: string) {
  try {
    const report = await withTimeout(perf.getPerformanceMetrics(userId, workspaceId, timeZone), surveyConfig.productivityTimeoutMs);
    if (!report) throw new Error('No performance data available');
    return { index: report.productivityIndex, data: report, unavailableReason: report.productivityIndex === null ? 'NO_DATA' : null };
  } catch (error) {
    logger.warn('productivity unavailable for survey', { error, userId });
    return { index: null, data: null, unavailableReason: error instanceof Error ? error.message : 'UNKNOWN' };
  }
}

// ─── Presentation ───────────────────────────────────────────────────────────

const summaryInclude = {
  template: { select: { id: true, name: true } },
  evaluator: { select: { id: true, displayName: true } },
  evaluatedUser: { select: { id: true, displayName: true, role: true } },
  department: { select: { id: true, name: true, color: true } },
} satisfies Prisma.SurveyInclude;
type SurveyRow = Prisma.SurveyGetPayload<{ include: typeof summaryInclude }>;

const detailInclude = {
  ...summaryInclude,
  template: { select: { id: true, name: true, questions: { orderBy: { questionNumber: 'asc' as const } } } },
  responses: true,
} satisfies Prisma.SurveyInclude;
type SurveyDetailRow = Prisma.SurveyGetPayload<{ include: typeof detailInclude }>;

const OPEN: SurveyStatus[] = ['SCHEDULED', 'ACTIVE'];
const isOpen = (s: Pick<Survey, 'status'>) => OPEN.includes(s.status);

// CR-02: every write re-checks, under the row lock, that the survey is still in
// a state the checks were made for. The UPDATE locks the row until the
// transaction ends, so a concurrent submit/cancel/save waits for it and then
// finds the status changed → 409 instead of silently overwriting.
async function claim(tx: Tx, id: string, statuses: SurveyStatus[]) {
  const { count } = await tx.survey.updateMany({ where: { id, status: { in: statuses } }, data: { updatedAt: new Date() } });
  if (count === 0) throw new AppError(409, 'SURVEY_STATE_CHANGED', 'La encuesta cambió de estado mientras tanto; recarga la página');
}

function presentSummary(user: AuthUser, s: SurveyRow, now = new Date()) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    type: s.type,
    status: s.status,
    isOverdue: isOpen(s) && s.endDate < now,
    template: { id: s.template.id, name: s.template.name },
    evaluator: s.evaluator,
    evaluatedUser: { id: s.evaluatedUser.id, displayName: s.evaluatedUser.displayName },
    department: s.department,
    startDate: s.startDate,
    endDate: s.endDate,
    reviewPeriod: s.reviewPeriod,
    totalQuestions: s.totalQuestions,
    answeredQuestions: s.answeredQuestions,
    completionPercentage: s.completionPercentage,
    completedAt: s.completedAt,
    cancelledAt: s.cancelledAt,
    productivityIndex: s.productivityIndex,
    performanceScore: s.performanceScore,
    dualScore: s.dualScore,
    createdAt: s.createdAt,
    permissions: {
      canAnswer: answerBlock(user, s, now) === null,
      canCancel: isOpen(s) && canManageEvaluationsOf(user, { id: s.evaluatedUserId, departmentId: s.departmentId, role: s.evaluatedUser.role }),
    },
  };
}

function presentDetail(user: AuthUser, s: SurveyDetailRow) {
  return {
    ...presentSummary(user, s),
    productivityData: s.productivityData,
    questions: s.template.questions.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      questionType: q.questionType,
      weight: q.weight,
      required: q.required,
      options: q.options,
    })),
    responses: s.responses.map((r) => ({ questionId: r.questionId, value: r.value, comment: r.comment, updatedAt: r.updatedAt })),
  };
}

// ─── Loading & access (Risk 1) ──────────────────────────────────────────────

async function isReviewPublished(s: Pick<Survey, 'evaluatedUserId' | 'reviewPeriod'>) {
  const review = await prisma.performanceReview.findUnique({
    where: { userId_reviewPeriod: { userId: s.evaluatedUserId, reviewPeriod: s.reviewPeriod } },
    select: { publishedAt: true },
  });
  return !!review?.publishedAt;
}

// 404 outside the workspace; 403 when it exists but the user may not see it.
async function loadVisible(user: AuthUser, id: string): Promise<SurveyDetailRow> {
  const s = await prisma.survey.findFirst({ where: { id, workspaceId: user.workspaceId }, include: detailInclude });
  if (!s) throw notFound('Survey');
  const published = s.evaluatedUserId === user.id ? await isReviewPublished(s) : false;
  if (!checkSurveyAccess(user, s, published)) throw forbidden('No tienes acceso a esta encuesta');
  return s;
}

// Risk 7: why `user` may not write answers right now (null = allowed).
// Only the evaluator answers; an ADMIN may also correct, even after submission
// or the deadline. A cancelled survey is closed for everyone.
function answerBlock(user: AuthUser, s: Pick<Survey, 'evaluatorId' | 'status' | 'startDate' | 'endDate'>, now = new Date()): AppError | null {
  const admin = user.role === 'ADMIN';
  if (s.status === 'CANCELLED') return new AppError(403, 'SURVEY_CANCELLED', 'La encuesta fue cancelada');
  if (!admin && s.evaluatorId !== user.id) return new AppError(403, 'FORBIDDEN', 'Solo el evaluador responde esta encuesta');
  if (admin) return null;
  if (s.status === 'COMPLETED') return new AppError(403, 'SURVEY_LOCKED', 'La encuesta ya fue enviada y no puede editarse');
  if (now < s.startDate) return new AppError(403, 'SURVEY_NOT_STARTED', 'La encuesta todavía no empieza');
  if (now > s.endDate) return new AppError(403, 'SURVEY_DEADLINE_PASSED', 'La fecha límite de la encuesta ya pasó');
  return null;
}

function broadcast(s: Pick<Survey, 'id' | 'workspaceId' | 'evaluatorId' | 'evaluatedUserId' | 'departmentId' | 'status'>) {
  emitTo([rooms.admins(s.workspaceId), rooms.user(s.evaluatorId), rooms.department(s.departmentId)], 'survey:changed', {
    surveyId: s.id,
    status: s.status,
  });
}

async function afterStatusChange(s: Survey) {
  await upsertPerformanceReview(s.workspaceId, s.evaluatedUserId, s.reviewPeriod);
  await invalidateSurveyDashboards(s.workspaceId, s.reviewPeriod, s.departmentId);
  broadcast(s);
}

// ─── Create ─────────────────────────────────────────────────────────────────

// One open (SCHEDULED/ACTIVE) survey per evaluated person, evaluator and type.
// (A self-assessment and a manager review of the same person are different pairs.)
async function assertNoOpenDuplicate(db: Tx, pair: Pick<Survey, 'workspaceId' | 'evaluatedUserId' | 'evaluatorId' | 'type'>) {
  const duplicate = await db.survey.findFirst({ where: { ...pair, status: { in: OPEN } }, select: { id: true } });
  if (duplicate) throw conflict('Ya hay una encuesta abierta igual para esta persona', 'SURVEY_EXISTS', { surveyId: duplicate.id });
}

export async function createSurvey(user: AuthUser, input: CreateSurveyInput, ctx: ClientContext) {
  if (user.role !== 'ADMIN' && user.role !== 'JEFE_AREA') throw forbidden('Solo el director o un jefe de área crean evaluaciones');

  // Risk 5: every rule through the central validators.
  const now = new Date();
  validateCreateSurveyData(input, now);
  const template = await prisma.surveyTemplate.findFirst({
    where: { id: input.templateId, workspaceId: user.workspaceId },
    select: { id: true, name: true, status: true, _count: { select: { questions: true } } },
  });
  validateTemplateStatus(template);

  const evaluated = await prisma.user.findUnique({ where: { id: input.evaluatedUserId } });
  validateUserExists(evaluated, user.workspaceId);
  if (!evaluated.departmentId) throw validationError('La persona evaluada no tiene departamento', [{ field: 'evaluatedUserId', message: 'no department' }]);
  if (!canManageEvaluationsOf(user, evaluated)) throw forbidden('Solo evalúas a personas de tu propio departamento');

  let evaluatorId: string;
  if (input.type === 'SELF_ASSESSMENT') {
    if (input.evaluatorId && input.evaluatorId !== evaluated.id) {
      throw validationError('En una autoevaluación el evaluador es la propia persona', [{ field: 'evaluatorId', message: 'must equal evaluatedUserId' }]);
    }
    if (evaluated.role === 'VIEWER') throw validationError('Un lector no puede responder encuestas', [{ field: 'evaluatedUserId', message: 'viewer' }]);
    evaluatorId = evaluated.id;
  } else {
    evaluatorId = input.evaluatorId ?? user.id;
    if (evaluatorId === evaluated.id) throw validationError('Nadie hace la evaluación de jefe sobre sí mismo', [{ field: 'evaluatorId', message: 'same as evaluated' }]);
    const evaluator = evaluatorId === user.id ? { ...user, workspaceId: user.workspaceId, deletedAt: null } : await prisma.user.findUnique({ where: { id: evaluatorId } });
    validateUserExists(evaluator, user.workspaceId, 'evaluatorId');
    // An area head reviews their team; another head (a peer) is reviewed by the director (CR-01).
    const managesArea =
      evaluator.role === 'ADMIN' ||
      (evaluator.role === 'JEFE_AREA' && evaluator.departmentId === evaluated.departmentId && evaluated.role !== 'JEFE_AREA');
    if (!managesArea) throw validationError('El evaluador debe ser el director o el jefe del área', [{ field: 'evaluatorId', message: 'not a manager of the area' }]);
  }

  const pair = { workspaceId: user.workspaceId, evaluatedUserId: evaluated.id, evaluatorId, type: input.type };
  // Cheap early answer before paying for Module 1; the check that counts is the locked one below.
  await assertNoOpenDuplicate(prisma, pair);

  const productivity = await captureProductivity(user.workspaceId, evaluated.id, user.workspaceTimezone);
  const period = input.reviewPeriod ?? reviewPeriodOf(localDay(input.startDate, user.workspaceTimezone));

  const survey = await prisma.$transaction(async (tx) => {
    // CR-03: two concurrent creations of the same (evaluated, evaluator, type)
    // queue on this lock, so the second one sees the first and gets 409.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`survey:${evaluated.id}:${evaluatorId}:${input.type}`}, 0))`;
    await assertNoOpenDuplicate(tx, pair);
    const created = await tx.survey.create({
      data: {
        workspaceId: user.workspaceId,
        templateId: template.id,
        type: input.type,
        title: input.title ?? `${TYPE_LABEL[input.type]} · ${evaluated.displayName} · ${period}`,
        description: input.description ?? null,
        evaluatorId,
        evaluatedUserId: evaluated.id,
        departmentId: evaluated.departmentId!,
        createdById: user.id,
        startDate: input.startDate,
        endDate: input.endDate,
        status: input.startDate <= now ? 'ACTIVE' : 'SCHEDULED',
        reviewPeriod: period,
        totalQuestions: template._count.questions,
        productivityIndex: productivity.index,
        productivityData: (productivity.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const base = { workspaceId: user.workspaceId, userId: user.id, entityType: 'Survey', entityId: created.id, ipAddress: ctx.ipAddress };
    await logActivity(
      { ...base, action: ActivityAction.SURVEY_CREATED, metadata: { type: created.type, evaluatedUserId: evaluated.id, evaluatorId, templateId: template.id, period } },
      tx,
    );
    if (productivity.index === null) {
      await logActivity(
        { ...base, action: ActivityAction.SURVEY_CREATED_WITHOUT_PRODUCTIVITY, metadata: { evaluatedUserId: evaluated.id, reason: productivity.unavailableReason } },
        tx,
      );
    }
    return created;
  });

  await afterStatusChange(survey);
  await notifySafely({
    workspaceId: user.workspaceId,
    recipientIds: [evaluatorId],
    type: 'SURVEY_ASSIGNED',
    actor: { id: user.id, displayName: user.displayName },
    title: survey.type === 'SELF_ASSESSMENT' ? 'Tienes una autoevaluación pendiente' : `Evalúa a ${evaluated.displayName}`,
    body: `${survey.title} — vence el ${localDay(survey.endDate, user.workspaceTimezone)}`,
  });
  return { survey: presentDetail(user, await loadVisible(user, survey.id)) };
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function listSurveys(user: AuthUser, q: ListSurveysQuery) {
  if (user.role === 'VIEWER') throw forbidden();
  const publishedPeriods =
    user.role === 'ADMIN'
      ? []
      : (await prisma.performanceReview.findMany({ where: { userId: user.id, publishedAt: { not: null } }, select: { reviewPeriod: true } })).map((r) => r.reviewPeriod);
  const where: Prisma.SurveyWhereInput = {
    AND: [
      surveyVisibilityFilter(user, publishedPeriods),
      {
        ...(q.scope === 'assigned' ? { evaluatorId: user.id } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(q.evaluatedUserId ? { evaluatedUserId: q.evaluatedUserId } : {}),
        ...(q.period ? { reviewPeriod: q.period } : {}),
      },
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.survey.findMany({
      where,
      include: summaryInclude,
      orderBy: q.scope === 'assigned' ? [{ status: 'asc' }, { endDate: 'asc' }] : [{ createdAt: 'desc' }],
      ...toSkipTake(q),
    }),
    prisma.survey.count({ where }),
  ]);
  const now = new Date();
  return { data: rows.map((s) => presentSummary(user, s, now)), pagination: { page: q.page, limit: q.limit, total } };
}

export async function getSurvey(user: AuthUser, id: string) {
  return { survey: presentDetail(user, await loadVisible(user, id)) };
}

// ─── Answer & submit ────────────────────────────────────────────────────────

export async function saveResponses(user: AuthUser, id: string, input: SaveResponsesInput, ctx: ClientContext) {
  const s = await loadVisible(user, id);
  const now = new Date();
  const block = answerBlock(user, s, now);
  if (block) throw block;

  const errors: { field: string; message: string }[] = [];
  input.answers.forEach((a, i) => {
    const q = s.template.questions.find((x) => x.id === a.questionId);
    if (!q) errors.push({ field: `answers.${i}.questionId`, message: 'La pregunta no pertenece a esta encuesta' });
    else if (a.value !== null) {
      const problem = validateAnswerValue(q, a.value);
      if (problem) errors.push({ field: `answers.${i}.value`, message: problem });
    }
  });
  if (errors.length) throw validationError('Respuestas inválidas', errors);

  const correcting = s.status === 'COMPLETED';
  const updated = await prisma.$transaction(async (tx) => {
    // SCHEDULED→ACTIVE by the scheduler meanwhile is fine; submitted/cancelled is not.
    await claim(tx, s.id, isOpen(s) ? OPEN : [s.status]);
    for (const a of input.answers) {
      if (a.value === null) {
        await tx.surveyResponse.deleteMany({ where: { surveyId: s.id, questionId: a.questionId } });
        continue;
      }
      const value = a.value as Prisma.InputJsonValue;
      await tx.surveyResponse.upsert({
        where: { surveyId_questionId: { surveyId: s.id, questionId: a.questionId } },
        create: { surveyId: s.id, questionId: a.questionId, respondentId: s.evaluatorId, value, comment: a.comment ?? null },
        update: { value, ...(a.comment !== undefined ? { comment: a.comment ?? null } : {}) },
      });
    }
    const answered = await tx.surveyResponse.count({ where: { surveyId: s.id } });
    const data: Prisma.SurveyUpdateInput = {
      answeredQuestions: answered,
      completionPercentage: s.totalQuestions > 0 ? Math.round((answered / s.totalQuestions) * 1000) / 10 : 0,
      // First answer after the start date and before the scheduler got to it.
      ...(s.status === 'SCHEDULED' && s.startDate <= now ? { status: 'ACTIVE' as const } : {}),
    };
    if (correcting) {
      const responses = await tx.surveyResponse.findMany({ where: { surveyId: s.id } });
      validateSurveyCompletion(s.template.questions, new Set(responses.map((r) => r.questionId)));
      const performanceScore = calculatePerformanceScore(s.template.questions, responses);
      data.performanceScore = performanceScore;
      data.dualScore = calculateDualScore(s.productivityIndex, performanceScore) as unknown as Prisma.InputJsonValue;
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.SURVEY_RESPONSES_CORRECTED,
          entityType: 'Survey',
          entityId: s.id,
          metadata: { questionIds: input.answers.map((a) => a.questionId), performanceScore },
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
    }
    return tx.survey.update({ where: { id: s.id }, data });
  });

  if (correcting || updated.status !== s.status) await afterStatusChange(updated);
  return { survey: presentDetail(user, await loadVisible(user, id)) };
}

// Risk 3: compute performanceScore (null when no scored answer) and the dual score.
export async function submitSurvey(user: AuthUser, id: string, ctx: ClientContext) {
  const s = await loadVisible(user, id);
  const block = answerBlock(user, s);
  if (block) throw block;
  if (s.status === 'COMPLETED') throw new AppError(409, 'SURVEY_ALREADY_SUBMITTED', 'La encuesta ya fue enviada');

  validateSurveyCompletion(s.template.questions, new Set(s.responses.map((r) => r.questionId)));

  const updated = await prisma.$transaction(async (tx) => {
    await claim(tx, s.id, OPEN);
    // Scored from the answers as they are under the lock, not as first read.
    const responses = await tx.surveyResponse.findMany({ where: { surveyId: s.id } });
    validateSurveyCompletion(s.template.questions, new Set(responses.map((r) => r.questionId)));
    const performanceScore = calculatePerformanceScore(s.template.questions, responses);
    const dualScore = calculateDualScore(s.productivityIndex, performanceScore);
    const done = await tx.survey.update({
      where: { id: s.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        performanceScore,
        dualScore: dualScore as unknown as Prisma.InputJsonValue,
        answeredQuestions: responses.length,
        completionPercentage: s.totalQuestions > 0 ? Math.round((responses.length / s.totalQuestions) * 1000) / 10 : 0,
      },
    });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.SURVEY_SUBMITTED,
        entityType: 'Survey',
        entityId: s.id,
        metadata: { type: s.type, evaluatedUserId: s.evaluatedUserId, performanceScore, overallScore: dualScore.overall_score },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return done;
  });

  await afterStatusChange(updated);
  return { survey: presentDetail(user, await loadVisible(user, id)) };
}

export async function cancelSurvey(user: AuthUser, id: string, ctx: ClientContext) {
  const s = await loadVisible(user, id);
  if (!canManageEvaluationsOf(user, { id: s.evaluatedUserId, departmentId: s.departmentId, role: s.evaluatedUser.role })) throw forbidden('Solo el director o el jefe del área cancelan');
  if (!isOpen(s)) throw new AppError(409, 'SURVEY_CLOSED', 'Solo se cancelan encuestas pendientes');

  const updated = await prisma.$transaction(async (tx) => {
    await claim(tx, id, OPEN);
    const done = await tx.survey.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.SURVEY_CANCELLED,
        entityType: 'Survey',
        entityId: id,
        changes: { status: { old: s.status, new: 'CANCELLED' } },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return done;
  });
  await afterStatusChange(updated);
  return { survey: presentDetail(user, await loadVisible(user, id)) };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

// SCHEDULED → ACTIVE once startDate arrives. Runs every minute.
export async function activateDueSurveys(now = new Date()) {
  const due = await prisma.survey.findMany({
    where: { status: 'SCHEDULED', startDate: { lte: now } },
    select: { id: true, workspaceId: true, reviewPeriod: true, departmentId: true, evaluatorId: true, evaluatedUserId: true },
  });
  if (!due.length) return 0;
  await prisma.survey.updateMany({ where: { id: { in: due.map((s) => s.id) }, status: 'SCHEDULED' }, data: { status: 'ACTIVE' } });
  const scopes = new Map(due.map((s) => [`${s.workspaceId}|${s.reviewPeriod}|${s.departmentId}`, s]));
  for (const s of scopes.values()) await invalidateSurveyDashboards(s.workspaceId, s.reviewPeriod, s.departmentId);
  for (const s of due) broadcast({ ...s, status: 'ACTIVE' });
  logger.info('surveys activated', { count: due.length });
  return due.length;
}

export function startSurveyScheduler(intervalMs = 60_000) {
  const run = () => void activateDueSurveys().catch((error) => logger.error('survey scheduler crashed', { error }));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
