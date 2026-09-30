import * as cache from '../../src/lib/cache';
import { prisma } from '../../src/lib/prisma';
import * as perf from '../../src/modules/performance/performance.service';
import { activateDueSurveys, surveyConfig } from '../../src/modules/surveys/surveys.service';
import { dueAt, seedWorkspace, type Actor, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

const QUESTIONS = [
  { text: 'Calidad del trabajo', questionType: 'LIKERT_5' },
  { text: 'Trabajo en equipo', questionType: 'LIKERT_7', weight: 2 },
  { text: 'Cumplimiento de metas (0-100)', questionType: 'NUMERIC' },
  { text: 'Comentarios', questionType: 'TEXT', required: false },
];

async function activeTemplate(questions: unknown[] = QUESTIONS) {
  const created = await call('POST', '/api/v1/surveys/templates', { token: s.admin.token, body: { name: 'Evaluación trimestral', questions } });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const res = await call('PATCH', `/api/v1/surveys/templates/${created.body.template.id}/status`, { token: s.admin.token, body: { status: 'ACTIVE' } });
  return res.body.template as { id: string; questions: { id: string; questionType: string }[] };
}

async function createSurvey(token: string, body: Record<string, unknown>) {
  return call('POST', '/api/v1/surveys', { token, body: { startDate: inDays(-1), endDate: inDays(14), ...body } });
}

// Fills 4 / 7 / 90 → (75 + 100·2 + 90) / 4 = 91.3
function fullAnswers(t: { questions: { id: string }[] }) {
  return [
    { questionId: t.questions[0]!.id, value: 4 },
    { questionId: t.questions[1]!.id, value: 7 },
    { questionId: t.questions[2]!.id, value: 90 },
    { questionId: t.questions[3]!.id, value: 'Muy buen trimestre' },
  ];
}

async function answerAndSubmit(actor: Actor, surveyId: string, t: { questions: { id: string }[] }) {
  const saved = await call('POST', `/api/v1/surveys/${surveyId}/responses`, { token: actor.token, body: { answers: fullAnswers(t) } });
  expect(saved.status).toBe(200);
  const submitted = await call('POST', `/api/v1/surveys/${surveyId}/submit`, { token: actor.token });
  expect(submitted.status).toBe(200);
  return submitted.body.survey;
}

async function task(assignee: Actor, departmentId: string, dueOffset: number, progress: number, completedOffset?: number) {
  await prisma.task.create({
    data: {
      workspaceId: s.workspaceId,
      departmentId,
      createdById: s.admin.id,
      assignedToId: assignee.id,
      title: `Tarea ${dueOffset}`,
      dueDate: new Date(dueAt(dueOffset)),
      progress,
      status: progress >= 100 ? 'DONE' : 'IN_PROGRESS',
      actualCompletionDate: completedOffset === undefined ? null : new Date(dueAt(completedOffset)),
    },
  });
}

describe('Module 1: GET /workspaces/:id/team/:userId/performance', () => {
  it('measures completion and punctuality from the person’s tasks', async () => {
    await task(s.mkt.user, s.marketing, -5, 100, -6); // early
    await task(s.mkt.user, s.marketing, -4, 100, -4); // on the day
    await task(s.mkt.user, s.marketing, -3, 100, -1); // late
    await task(s.mkt.user, s.marketing, -2, 50); // overdue, not done
    await task(s.mkt.user, s.marketing, 5, 0); // not due yet → ignored
    await task(s.mkt.user, s.marketing, -60, 100, -60); // outside the 4-week window

    const res = await call('GET', `/api/v1/workspaces/${s.workspaceId}/team/${s.mkt.user.id}/performance`, { token: s.mkt.user.token });
    expect(res.status).toBe(200);
    expect(res.body.performance).toMatchObject({
      tasks: { due: 4, completed: 3, onTime: 2, late: 1 },
      metrics: { completion_rate: 75, on_time_rate: 66.7, collaboration_score: null, kpi_achievement: null },
      productivityIndex: 70.9, // (75·0.3 + 66.7·0.3) / 0.6
    });
  });

  it('is visible to the person, their area head and the director only', async () => {
    const url = `/api/v1/workspaces/${s.workspaceId}/team/${s.mkt.user.id}/performance`;
    expect((await call('GET', url, { token: s.admin.token })).status).toBe(200);
    expect((await call('GET', url, { token: s.mkt.jefe.token })).status).toBe(200);
    expect((await call('GET', url, { token: s.fin.jefe.token })).status).toBe(403);
    expect((await call('GET', url, { token: s.mkt.user2.token })).status).toBe(403);
    expect((await call('GET', `/api/v1/workspaces/00000000-0000-4000-8000-000000000000/team/${s.mkt.user.id}/performance`, { token: s.admin.token })).status).toBe(404);
  });
});

describe('survey templates (Risk 3)', () => {
  it('ADMIN only; needs 3+ questions with at least one scored; frozen once active', async () => {
    const post = (token: string, questions: unknown[]) => call('POST', '/api/v1/surveys/templates', { token, body: { name: 'T', questions } });
    expect((await post(s.mkt.jefe.token, QUESTIONS)).status).toBe(403);
    expect((await post(s.admin.token, QUESTIONS.slice(0, 2))).status).toBe(422);
    const textOnly = await post(s.admin.token, [
      { text: 'a', questionType: 'TEXT' },
      { text: 'b', questionType: 'TEXT' },
      { text: 'c', questionType: 'RANKING', options: ['x', 'y'] },
    ]);
    expect(textOnly.status).toBe(422);
    expect(JSON.stringify(textOnly.body.error.details)).toContain('LIKERT_5');

    const draft = await post(s.admin.token, QUESTIONS);
    expect(draft.status).toBe(201);
    expect(draft.body.template).toMatchObject({ status: 'DRAFT', questions: [{ questionNumber: 1 }, {}, {}, { required: false }] });
    const id = draft.body.template.id;

    // Area heads only ever see active templates.
    expect((await call('GET', '/api/v1/surveys/templates', { token: s.mkt.jefe.token })).body.data).toEqual([]);
    expect((await call('PATCH', `/api/v1/surveys/templates/${id}`, { token: s.admin.token, body: { name: 'Renombrada' } })).status).toBe(200);
    expect((await call('PATCH', `/api/v1/surveys/templates/${id}/status`, { token: s.admin.token, body: { status: 'ACTIVE' } })).status).toBe(200);
    expect((await call('GET', '/api/v1/surveys/templates', { token: s.mkt.jefe.token })).body.data).toHaveLength(1);
    expect((await call('PATCH', `/api/v1/surveys/templates/${id}`, { token: s.admin.token, body: { name: 'Otra' } })).body.error.code).toBe('TEMPLATE_LOCKED');
    expect((await call('DELETE', `/api/v1/surveys/templates/${id}`, { token: s.admin.token })).status).toBe(409);
    expect(await prisma.activityLog.count({ where: { action: { startsWith: 'SURVEY_TEMPLATE_' } } })).toBe(3);
  });
});

describe('creating surveys (Risk 2 + 5)', () => {
  it('captures the productivity index and notifies the evaluator', async () => {
    const t = await activeTemplate();
    await task(s.mkt.user, s.marketing, -2, 100, -2);
    const res = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    expect(res.status).toBe(201);
    expect(res.body.survey).toMatchObject({
      status: 'ACTIVE',
      type: 'MANAGER_REVIEW',
      evaluator: { id: s.mkt.jefe.id },
      evaluatedUser: { id: s.mkt.user.id },
      department: { id: s.marketing },
      totalQuestions: 4,
      productivityIndex: 100,
      reviewPeriod: expect.stringMatching(/^\d{4}-Q[1-4]$/),
    });

    const self = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id, startDate: inDays(2), reviewPeriod: '2026-Q3' });
    expect(self.body.survey).toMatchObject({ status: 'SCHEDULED', evaluator: { id: s.mkt.user.id }, reviewPeriod: '2026-Q3' });
    const notes = await prisma.notification.findMany({ where: { userId: s.mkt.user.id, type: 'SURVEY_ASSIGNED' } });
    expect(notes).toHaveLength(1);
  });

  it('validates everything centrally', async () => {
    const t = await activeTemplate();
    const base = { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id };
    const draft = await call('POST', '/api/v1/surveys/templates', { token: s.admin.token, body: { name: 'Borrador', questions: QUESTIONS } });

    expect((await createSurvey(s.mkt.jefe.token, { ...base, templateId: draft.body.template.id })).status).toBe(422);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, startDate: inDays(5), endDate: inDays(1) })).status).toBe(422);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, startDate: inDays(-10), endDate: inDays(-1) })).status).toBe(422);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, evaluatedUserId: s.fin.user.id })).status).toBe(403);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, evaluatorId: s.fin.jefe.id })).status).toBe(422);
    expect((await createSurvey(s.mkt.user.token, base)).status).toBe(403);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, evaluatedUserId: s.mkt.jefe.id })).status).toBe(403);
    expect((await createSurvey(s.mkt.jefe.token, { ...base, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.viewer.id })).status).toBe(422);

    expect((await createSurvey(s.mkt.jefe.token, base)).status).toBe(201);
    const dup = await createSurvey(s.mkt.jefe.token, base);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SURVEY_EXISTS');
  });

  it('is created without productivity when Module 1 fails, and that is audited', async () => {
    const t = await activeTemplate();
    jest.spyOn(perf, 'getPerformanceMetrics').mockRejectedValue(new Error('Module 1 down'));
    const res = await createSurvey(s.admin.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    expect(res.status).toBe(201);
    expect(res.body.survey.productivityIndex).toBeNull();
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SURVEY_CREATED_WITHOUT_PRODUCTIVITY' } });
    expect(log).toMatchObject({ entityId: res.body.survey.id, metadata: { evaluatedUserId: s.mkt.user.id, reason: 'Module 1 down' } });
  });

  it('does not wait for a Module 1 that hangs', async () => {
    const t = await activeTemplate();
    surveyConfig.productivityTimeoutMs = 50;
    try {
      jest.spyOn(perf, 'getPerformanceMetrics').mockReturnValue(new Promise(() => undefined));
      const res = await createSurvey(s.admin.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
      expect(res.status).toBe(201);
      expect(res.body.survey.productivityIndex).toBeNull();
      const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SURVEY_CREATED_WITHOUT_PRODUCTIVITY' } });
      expect(log.metadata).toMatchObject({ reason: 'Timed out after 50 ms' });
    } finally {
      surveyConfig.productivityTimeoutMs = 3000;
    }
  });
});

describe('survey visibility (Risk 1)', () => {
  it('GET /surveys/:id answers 403 to everyone outside the rules', async () => {
    const t = await activeTemplate();
    const { body } = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    const url = `/api/v1/surveys/${body.survey.id}`;
    const status = async (a: Actor) => (await call('GET', url, { token: a.token })).status;

    expect(await status(s.admin)).toBe(200);
    expect(await status(s.mkt.jefe)).toBe(200); // evaluator
    expect(await status(s.mkt.jefeNoGrant)).toBe(200); // same department
    expect(await status(s.fin.jefe)).toBe(403);
    expect(await status(s.mkt.user)).toBe(403); // about them, not published
    expect(await status(s.mkt.user2)).toBe(403);
    expect(await status(s.mkt.viewer)).toBe(403);

    // Even with a visibility grant over Marketing, HR data stays closed.
    await call('PATCH', '/api/v1/permissions/JEFE_AREA', { token: s.admin.token, body: { userId: s.fin.jefe.id, visibleDepartmentIds: [s.marketing] } });
    expect(await status(s.fin.jefe)).toBe(403);
  });

  it('lists only what each role may see', async () => {
    const t = await activeTemplate();
    await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    await createSurvey(s.fin.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.fin.user.id });

    const count = async (a: Actor, qs = '') => (await call('GET', `/api/v1/surveys${qs}`, { token: a.token })).body.pagination?.total;
    expect(await count(s.admin)).toBe(3);
    expect(await count(s.mkt.jefe)).toBe(2);
    expect(await count(s.fin.jefe)).toBe(1);
    expect(await count(s.mkt.user)).toBe(1); // their self-assessment only
    expect(await count(s.mkt.jefe, '?scope=assigned')).toBe(1);
    expect((await call('GET', '/api/v1/surveys', { token: s.mkt.viewer.token })).status).toBe(403);
  });
});

describe('answering and submitting (Risk 3 + 7)', () => {
  it('saves drafts, requires every mandatory answer, then locks the survey', async () => {
    const t = await activeTemplate();
    const { body } = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    const id = body.survey.id;
    const respond = (a: Actor, answers: unknown[]) => call('POST', `/api/v1/surveys/${id}/responses`, { token: a.token, body: { answers } });

    expect((await respond(s.mkt.jefe, [{ questionId: t.questions[0]!.id, value: 3 }])).status).toBe(403); // not the evaluator
    expect((await respond(s.mkt.user, [{ questionId: t.questions[0]!.id, value: 9 }])).status).toBe(422);
    expect((await respond(s.mkt.user, [{ questionId: t.questions[3]!.id, value: 5 }])).status).toBe(422); // TEXT expects text

    const draft = await respond(s.mkt.user, [{ questionId: t.questions[0]!.id, value: 3 }]);
    expect(draft.body.survey).toMatchObject({ status: 'ACTIVE', answeredQuestions: 1, completionPercentage: 25 });
    // Saving again updates the same answer instead of adding one.
    const again = await respond(s.mkt.user, [{ questionId: t.questions[0]!.id, value: 4 }]);
    expect(again.body.survey.answeredQuestions).toBe(1);

    const early = await call('POST', `/api/v1/surveys/${id}/submit`, { token: s.mkt.user.token });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('SURVEY_INCOMPLETE');
    expect(early.body.error.details.missingQuestionIds).toHaveLength(2);

    const done = await answerAndSubmit(s.mkt.user, id, t);
    expect(done).toMatchObject({ status: 'COMPLETED', performanceScore: 91.3, answeredQuestions: 4 });
    expect(done.dualScore).toMatchObject({ performance_score: 91.3, status: expect.any(String) });

    const locked = await respond(s.mkt.user, [{ questionId: t.questions[0]!.id, value: 1 }]);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('SURVEY_LOCKED');
    expect((await call('POST', `/api/v1/surveys/${id}/submit`, { token: s.mkt.user.token })).status).toBe(403);

    // An ADMIN can still correct it; the scores follow.
    const fixed = await respond(s.admin, [{ questionId: t.questions[0]!.id, value: 1 }]);
    expect(fixed.status).toBe(200);
    expect(fixed.body.survey.performanceScore).toBe(72.5); // (0 + 200 + 90) / 4
    expect(await prisma.activityLog.count({ where: { action: 'SURVEY_RESPONSES_CORRECTED' } })).toBe(1);
  });

  it('rejects answers after the deadline and on cancelled surveys', async () => {
    const t = await activeTemplate();
    const a = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    await prisma.survey.update({ where: { id: a.body.survey.id }, data: { endDate: new Date(Date.now() - 1000) } });
    const late = await call('POST', `/api/v1/surveys/${a.body.survey.id}/responses`, { token: s.mkt.user.token, body: { answers: fullAnswers(t) } });
    expect(late.body.error.code).toBe('SURVEY_DEADLINE_PASSED');
    expect((await call('GET', `/api/v1/surveys/${a.body.survey.id}`, { token: s.mkt.user.token })).body.survey).toMatchObject({ isOverdue: true, permissions: { canAnswer: false } });

    const b = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user2.id });
    expect((await call('POST', `/api/v1/surveys/${b.body.survey.id}/cancel`, { token: s.mkt.user.token })).status).toBe(403);
    expect((await call('POST', `/api/v1/surveys/${b.body.survey.id}/cancel`, { token: s.mkt.jefe.token })).body.survey.status).toBe('CANCELLED');
    const cancelled = await call('POST', `/api/v1/surveys/${b.body.survey.id}/responses`, { token: s.mkt.jefe.token, body: { answers: fullAnswers(t) } });
    expect(cancelled.body.error.code).toBe('SURVEY_CANCELLED');
  });

  it('scores null when the only scored question was skipped; the dual score falls back to productivity', async () => {
    const t = await activeTemplate([
      { text: 'Opcional', questionType: 'LIKERT_5', required: false },
      { text: 'Logros', questionType: 'TEXT' },
      { text: 'Prioridades', questionType: 'RANKING', options: ['Ventas', 'Calidad'] },
    ]);
    jest.spyOn(perf, 'getPerformanceMetrics').mockResolvedValue({ productivityIndex: 64 } as never);
    const { body } = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    await call('POST', `/api/v1/surveys/${body.survey.id}/responses`, {
      token: s.mkt.user.token,
      body: { answers: [{ questionId: t.questions[1]!.id, value: 'Cerré 3 campañas' }, { questionId: t.questions[2]!.id, value: ['Calidad', 'Ventas'] }] },
    });
    const res = await call('POST', `/api/v1/surveys/${body.survey.id}/submit`, { token: s.mkt.user.token });
    expect(res.body.survey).toMatchObject({
      performanceScore: null,
      dualScore: { productivity_index: 64, performance_score: null, overall_score: 64, status: 'NEEDS_IMPROVEMENT' },
    });
  });

  it('the scheduler opens surveys whose start date arrived', async () => {
    const t = await activeTemplate();
    const { body } = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id, startDate: inDays(1) });
    expect(body.survey.status).toBe('SCHEDULED');
    expect(await activateDueSurveys()).toBe(0);
    expect(await activateDueSurveys(new Date(Date.now() + 2 * DAY))).toBe(1);
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: body.survey.id } })).status).toBe('ACTIVE');
  });
});

describe('performance reviews (Risk 6)', () => {
  it('aggregates completed surveys, and the person sees it once published', async () => {
    const t = await activeTemplate();
    jest.spyOn(perf, 'getPerformanceMetrics').mockResolvedValue({ productivityIndex: 80 } as never);
    const self = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    const mgr = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    await answerAndSubmit(s.mkt.user, self.body.survey.id, t);

    // Manager scores lower: 2 / 4 / 50 → (25 + 50·2 + 50) / 4 = 43.8
    await call('POST', `/api/v1/surveys/${mgr.body.survey.id}/responses`, {
      token: s.mkt.jefe.token,
      body: { answers: [{ questionId: t.questions[0]!.id, value: 2 }, { questionId: t.questions[1]!.id, value: 4 }, { questionId: t.questions[2]!.id, value: 50 }] },
    });
    await call('POST', `/api/v1/surveys/${mgr.body.survey.id}/submit`, { token: s.mkt.jefe.token });

    const list = await call('GET', '/api/v1/performance-reviews', { token: s.mkt.jefe.token });
    expect(list.body.data).toHaveLength(1);
    const review = list.body.data[0];
    // dual per survey: (80 + 91.3)/2 = 85.7 and (80 + 43.8)/2 = 61.9 → mean 73.8
    expect(review).toMatchObject({
      surveysCompleted: 2,
      surveysInitiated: 2,
      selfAssessmentScore: 91.3,
      managerReviewScore: 43.8,
      overallPerformanceScore: 67.6,
      overallProductivityIndex: 80,
      overallDualScore: 73.8,
      performanceRating: 'DEVELOPING',
      riskLevel: 'MEDIUM',
      publishedAt: null,
    });

    // Not visible to the person (nor the manager review) until published.
    expect((await call('GET', '/api/v1/performance-reviews', { token: s.mkt.user.token })).body.data).toHaveLength(0);
    expect((await call('GET', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.user.token })).status).toBe(403);
    expect((await call('GET', `/api/v1/performance-reviews/${review.id}`, { token: s.fin.jefe.token })).status).toBe(403);

    const edit = await call('PATCH', `/api/v1/performance-reviews/${review.id}`, {
      token: s.mkt.jefe.token,
      body: { managerComments: 'Buen avance', strengths: ['Creatividad'], developmentGoals: ['Plazos'], nextReviewDate: '2027-01-15' },
    });
    expect(edit.body.review).toMatchObject({ managerComments: 'Buen avance', strengths: ['Creatividad'], nextReviewDate: '2027-01-15' });
    expect((await call('PATCH', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.user.token, body: { employeeComments: 'Hola' } })).status).toBe(403);

    expect((await call('POST', `/api/v1/performance-reviews/${review.id}/publish`, { token: s.mkt.user.token })).status).toBe(403);
    expect((await call('POST', `/api/v1/performance-reviews/${review.id}/publish`, { token: s.mkt.jefe.token })).status).toBe(200);

    const mine = await call('GET', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.user.token });
    expect(mine.status).toBe(200);
    expect(mine.body.surveys.map((x: { type: string }) => x.type).sort()).toEqual(['MANAGER_REVIEW', 'SELF_ASSESSMENT']);
    expect((await call('GET', `/api/v1/surveys/${mgr.body.survey.id}`, { token: s.mkt.user.token })).status).toBe(200);

    const comment = await call('PATCH', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.user.token, body: { employeeComments: 'Gracias' } });
    expect(comment.body.review).toMatchObject({ employeeComments: 'Gracias', permissions: { canComment: true, canEdit: false } });
    expect((await call('PATCH', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.jefe.token, body: { employeeComments: 'x' } })).status).toBe(403);
    expect(await prisma.activityLog.count({ where: { action: 'PERFORMANCE_REVIEW_PUBLISHED' } })).toBe(1);
  });

  it('the dashboard counts by department and reflects changes immediately', async () => {
    const t = await activeTemplate();
    const a = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    await createSurvey(s.fin.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.fin.user.id });
    const period = a.body.survey.reviewPeriod;

    const before = await call('GET', `/api/v1/surveys/dashboard?period=${period}`, { token: s.admin.token });
    expect(before.body.totals.surveys).toMatchObject({ ACTIVE: 2, COMPLETED: 0, total: 2 });
    await answerAndSubmit(s.mkt.user, a.body.survey.id, t);
    const after = await call('GET', `/api/v1/surveys/dashboard?period=${period}`, { token: s.admin.token });
    const mkt = after.body.departments.find((d: { department: { id: string } }) => d.department.id === s.marketing);
    expect(mkt).toMatchObject({ surveys: { COMPLETED: 1 }, completionRate: 100, avgPerformanceScore: 91.3, reviews: { total: 1, published: 0 } });

    // Status changes drop the cached dashboards of the director and the area's heads.
    const spy = jest.spyOn(cache, 'invalidate');
    await call('POST', `/api/v1/surveys/${(await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user2.id })).body.survey.id}/cancel`, {
      token: s.mkt.jefe.token,
    });
    const keys = spy.mock.calls.flat();
    expect(keys).toContain(`surveys:dash:${s.workspaceId}:${period}:all`);
    for (const id of [s.mkt.jefe.id, s.mkt.jefeNoGrant.id]) expect(keys).toContain(`surveys:dash:${s.workspaceId}:${period}:jefe:${id}`);
    expect(keys).not.toContain(`surveys:dash:${s.workspaceId}:${period}:jefe:${s.fin.jefe.id}`);

    const jefe = await call('GET', `/api/v1/surveys/dashboard?period=${period}`, { token: s.mkt.jefe.token });
    expect(jefe.body.departments.map((d: { department: { id: string } }) => d.department.id)).toEqual([s.marketing]);
    expect((await call('GET', '/api/v1/surveys/dashboard', { token: s.mkt.user.token })).status).toBe(403);
  });
});
