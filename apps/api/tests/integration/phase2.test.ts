import { prisma } from '../../src/lib/prisma';
import { localDay } from '../../src/lib/week';
import { reviewPeriodOf } from '../../src/modules/surveys/scoring';
import { previousPeriods } from '../../src/modules/scorecard/scorecard.service';
import { seedWorkspace, WORKSPACE_TZ, type Actor, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;
const PERIOD = reviewPeriodOf(localDay(new Date(), WORKSPACE_TZ));

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});
afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

async function activeTemplate() {
  const questions = [
    { text: 'Calidad', questionType: 'LIKERT_5' },
    { text: 'Equipo', questionType: 'LIKERT_5' },
    { text: 'Logros', questionType: 'TEXT' },
  ];
  const t = await call('POST', '/api/v1/surveys/templates', { token: s.admin.token, body: { name: 'T', questions } });
  const res = await call('PATCH', `/api/v1/surveys/templates/${t.body.template.id}/status`, { token: s.admin.token, body: { status: 'ACTIVE' } });
  return res.body.template as { id: string; questions: { id: string }[] };
}

async function fill(actor: Actor, surveyId: string, t: { questions: { id: string }[] }, a: number, b: number) {
  const answers = [
    { questionId: t.questions[0]!.id, value: a },
    { questionId: t.questions[1]!.id, value: b },
    { questionId: t.questions[2]!.id, value: 'ok' },
  ];
  expect((await call('POST', `/api/v1/surveys/${surveyId}/responses`, { token: actor.token, body: { answers } })).status).toBe(200);
  const res = await call('POST', `/api/v1/surveys/${surveyId}/submit`, { token: actor.token });
  expect(res.status).toBe(200);
}

const survey = (token: string, body: Record<string, unknown>) =>
  call('POST', '/api/v1/surveys', { token, body: { startDate: inDays(-1), endDate: inDays(14), reviewPeriod: PERIOD, ...body } });

describe('CR-04: published results that change', () => {
  it('recalculates, stamps the review, audits before/after and tells the area heads', async () => {
    const t = await activeTemplate();
    const self = await survey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    const mgr = await survey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    await fill(s.mkt.user, self.body.survey.id, t, 5, 5); // 100
    const review = await prisma.performanceReview.findFirstOrThrow({ where: { userId: s.mkt.user.id } });
    expect(await prisma.activityLog.count({ where: { action: 'PERFORMANCE_REVIEW_RECALCULATED' } })).toBe(0);

    expect((await call('POST', `/api/v1/performance-reviews/${review.id}/publish`, { token: s.mkt.jefe.token })).status).toBe(200);
    await fill(s.mkt.jefe, mgr.body.survey.id, t, 3, 3); // 50 → the published result drops

    const after = await call('GET', `/api/v1/performance-reviews/${review.id}`, { token: s.mkt.jefe.token });
    expect(after.body.review).toMatchObject({ recalculationCount: 1, surveysCompleted: 2, lastRecalculatedAt: expect.any(String) });

    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'PERFORMANCE_REVIEW_RECALCULATED' } });
    expect(log).toMatchObject({ entityId: review.id, userId: s.mkt.jefe.id, metadata: { reason: 'SURVEY_SUBMITTED', surveyId: mgr.body.survey.id } });
    expect(log.changes).toMatchObject({ surveysCompleted: { old: 1, new: 2 }, overallPerformanceScore: { old: 100, new: 75 } });

    // The other head of Marketing is told; the actor isn't, and neither is the person.
    const notes = await prisma.notification.findMany({ where: { type: 'RESULT_RECALCULATED' } });
    expect(notes.map((n) => n.userId)).toEqual([s.mkt.jefeNoGrant.id]);
    expect(notes[0]!.title).toContain('fue recalculado');
  });

  it('no notice for unpublished results; manual recalculation is idempotent and manager-only', async () => {
    const t = await activeTemplate();
    const a = await survey(s.mkt.jefe.token, { templateId: t.id, type: 'SELF_ASSESSMENT', evaluatedUserId: s.mkt.user.id });
    const b = await survey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
    await fill(s.mkt.user, a.body.survey.id, t, 5, 5);
    await fill(s.mkt.jefe, b.body.survey.id, t, 1, 1);
    expect(await prisma.notification.count({ where: { type: 'RESULT_RECALCULATED' } })).toBe(0);

    const review = await prisma.performanceReview.findFirstOrThrow({ where: { userId: s.mkt.user.id } });
    const res = await call('POST', `/api/v1/performance-reviews/${review.id}/recalculate`, { token: s.mkt.jefe.token });
    expect(res.body).toMatchObject({ recalculated: false, review: { recalculationCount: 0 } });
    expect((await call('POST', `/api/v1/performance-reviews/${review.id}/recalculate`, { token: s.mkt.user.token })).status).toBe(403);
    expect((await call('POST', `/api/v1/performance-reviews/${review.id}/recalculate`, { token: s.fin.jefe.token })).status).toBe(403);
  });
});

const kr = (title: string, target = 10, startValue = 0) => ({ title, target, startValue });
const okr = (token: string, body: Record<string, unknown>) =>
  call('POST', '/api/v1/okrs', { token, body: { period: PERIOD, keyResults: [kr('KR 1'), kr('KR 2')], ...body } });

describe('OKRs', () => {
  it('cascade company → area → person with the right owners', async () => {
    expect((await okr(s.mkt.jefe.token, { level: 'COMPANY', title: 'X' })).status).toBe(403);
    const company = await okr(s.admin.token, { level: 'COMPANY', title: 'Crecer 10%' });
    expect(company.status).toBe(201);
    expect(company.body.okr).toMatchObject({ level: 'COMPANY', progress: 0, status: expect.any(String), keyResults: [{ progress: 0 }, {}] });

    expect((await okr(s.mkt.jefe.token, { level: 'AREA', departmentId: s.finanzas, title: 'X' })).status).toBe(403);
    const area = await okr(s.mkt.jefe.token, { level: 'AREA', departmentId: s.marketing, parentId: company.body.okr.id, title: 'Más leads' });
    expect(area.status).toBe(201);

    // Person: under an AREA of their department, only for the head's team.
    expect((await okr(s.mkt.jefe.token, { level: 'PERSON', ownerUserId: s.mkt.user.id, parentId: company.body.okr.id, title: 'X' })).status).toBe(422);
    expect((await okr(s.mkt.jefe.token, { level: 'PERSON', ownerUserId: s.mkt.jefeNoGrant.id, title: 'X' })).status).toBe(403);
    const person = await okr(s.mkt.jefe.token, { level: 'PERSON', ownerUserId: s.mkt.user.id, parentId: area.body.okr.id, title: '20 posts' });
    expect(person.status).toBe(201);
    expect(person.body.okr).toMatchObject({ owner: { id: s.mkt.user.id }, department: { id: s.marketing } });

    expect((await okr(s.admin.token, { level: 'COMPANY', title: 'X', deadline: '1999-01-01' })).status).toBe(422);
    expect((await okr(s.mkt.user.token, { level: 'AREA', departmentId: s.marketing, title: 'X' })).status).toBe(403);
    const otherQuarter = previousPeriods(PERIOD, 2)[0];
    expect((await okr(s.mkt.jefe.token, { period: otherQuarter, level: 'AREA', departmentId: s.marketing, parentId: company.body.okr.id, title: 'X' })).status).toBe(422);

    const tree = await call('GET', `/api/v1/okrs/tree?period=${PERIOD}`, { token: s.admin.token });
    expect(tree.body.summary.total).toBe(3);
    expect(tree.body.roots).toHaveLength(1);
    expect(tree.body.roots[0].children[0].children[0].id).toBe(person.body.okr.id);

    // Personal OKRs stay between the person and their managers.
    expect((await call('GET', `/api/v1/okrs/${person.body.okr.id}`, { token: s.mkt.user2.token })).status).toBe(403);
    expect((await call('GET', `/api/v1/okrs/tree?period=${PERIOD}`, { token: s.mkt.user2.token })).body.summary.total).toBe(2);
    expect((await call('GET', `/api/v1/okrs/tree?period=${PERIOD}`, { token: s.mkt.viewer.token })).body.summary.total).toBe(2);

    expect((await call('DELETE', `/api/v1/okrs/${company.body.okr.id}`, { token: s.admin.token })).body.error.code).toBe('OKR_HAS_CHILDREN');
    expect((await call('DELETE', `/api/v1/okrs/${person.body.okr.id}`, { token: s.mkt.jefe.token })).status).toBe(200);
    expect(await prisma.activityLog.count({ where: { action: { in: ['OKR_CREATED', 'OKR_DELETED'] } } })).toBe(4);
  });

  it('check-ins move progress, keep history, and editing key results keeps their values', async () => {
    const person = await okr(s.mkt.jefe.token, { level: 'PERSON', ownerUserId: s.mkt.user.id, title: 'Ventas', keyResults: [kr('Clientes', 10), kr('Churn', 5, 8)] });
    const [k1, k2] = person.body.okr.keyResults;
    const url = `/api/v1/okrs/${person.body.okr.id}/check-ins`;

    expect((await call('POST', url, { token: s.mkt.viewer.token, body: { notes: 'x' } })).status).toBe(403);
    expect((await call('POST', url, { token: s.mkt.user.token, body: {} })).status).toBe(422);
    const res = await call('POST', url, { token: s.mkt.user.token, body: { keyResults: [{ id: k1.id, current: 5 }, { id: k2.id, current: 6.5 }], notes: 'Buena semana' } });
    expect(res.status).toBe(201);
    expect(res.body.okr.progress).toBe(50); // (50 + 50) / 2
    expect(res.body.checkIns[0]).toMatchObject({ progress: 50, notes: 'Buena semana', author: { id: s.mkt.user.id }, values: [{ keyResultId: k1.id, previous: 0, current: 5 }, {}] });
    expect(await prisma.activityLog.count({ where: { action: 'OKR_CHECKED_IN' } })).toBe(1);

    // The person checks in but can't restructure; the head can.
    expect((await call('PATCH', `/api/v1/okrs/${person.body.okr.id}`, { token: s.mkt.user.token, body: { title: 'x' } })).status).toBe(403);
    const edit = await call('PATCH', `/api/v1/okrs/${person.body.okr.id}`, {
      token: s.mkt.jefe.token,
      body: { keyResults: [{ id: k1.id, title: 'Clientes nuevos', target: 10, startValue: 0 }, kr('NPS', 70, 50)] },
    });
    expect(edit.body.okr.keyResults.map((k: { title: string; current: number }) => [k.title, k.current])).toEqual([
      ['Clientes nuevos', 5],
      ['NPS', 50],
    ]);
    expect(edit.body.okr.progress).toBe(25);
  });
});

describe('performance scorecard', () => {
  async function review(actor: Actor, period: string, performance: number, productivity: number | null = null) {
    await prisma.performanceReview.create({
      data: {
        workspaceId: s.workspaceId,
        userId: actor.id,
        departmentId: actor.departmentId,
        reviewPeriod: period,
        overallPerformanceScore: performance,
        overallProductivityIndex: productivity,
        overallDualScore: performance,
        surveysCompleted: 1,
      },
    });
  }

  it('company KPIs, areas against their target, trend and alerts (director)', async () => {
    const previous = previousPeriods(PERIOD, 2)[0]!;
    await review(s.mkt.user, PERIOD, 90, 80);
    await review(s.mkt.user2, PERIOD, 70, 60);
    await review(s.mkt.jefe, PERIOD, 50);
    await review(s.fin.user, PERIOD, 60);
    await review(s.mkt.user, previous, 80);
    expect((await call('PATCH', `/api/v1/departments/${s.marketing}`, { token: s.admin.token, body: { performanceTarget: 85 } })).status).toBe(200);
    await okr(s.admin.token, { level: 'COMPANY', title: 'Hecho', keyResults: [kr('Listo', 5, 5)] }); // 100%
    await okr(s.admin.token, { level: 'COMPANY', title: 'Pendiente' });

    const res = await call('GET', `/api/v1/performance-dashboard?period=${PERIOD}`, { token: s.admin.token });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('company');
    expect(res.body.kpis).toMatchObject({
      performance: { value: 67.5, delta: -12.5 },
      productivity: { value: 70 },
      collaboration: { value: null, reason: 'NO_SOURCE' },
      okrCompletion: { value: 50, progress: 50, count: 2 },
    });
    expect(res.body.trend.map((t: { period: string }) => t.period)).toEqual(previousPeriods(PERIOD, 4));
    const mkt = res.body.areas.find((a: { department: { id: string } }) => a.department.id === s.marketing);
    expect(mkt).toMatchObject({ performance: 70, target: 85, status: 'BELOW' });
    const fin = res.body.areas.find((a: { department: { id: string } }) => a.department.id === s.finanzas);
    expect(fin).toMatchObject({ performance: 60, target: 80, status: 'BELOW' });
    expect(res.body.alerts.filter((a: { kind: string }) => a.kind === 'AREA_BELOW_TARGET')).toHaveLength(2);
  });

  it('a head sees their team (not peer heads), compared with the company', async () => {
    await review(s.mkt.user, PERIOD, 90);
    await review(s.mkt.user2, PERIOD, 70);
    await review(s.mkt.jefeNoGrant, PERIOD, 10);
    await review(s.fin.user, PERIOD, 50);

    const res = await call('GET', '/api/v1/performance-dashboard', { token: s.mkt.jefe.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'team', department: { id: s.marketing, target: 80 }, kpis: { performance: { value: 80 } } });
    expect(res.body.people.map((p: { user: { id: string } }) => p.user.id)).not.toContain(s.mkt.jefeNoGrant.id);
    expect(res.body.people.find((p: { user: { id: string } }) => p.user.id === s.mkt.user.id).review).toMatchObject({ performance: 90 });
    expect(res.body.company.performance).toBe(55);

    expect((await call('GET', `/api/v1/performance-dashboard?departmentId=${s.finanzas}`, { token: s.mkt.jefe.token })).status).toBe(403);
    expect((await call('GET', '/api/v1/performance-dashboard', { token: s.mkt.user.token })).status).toBe(403);
    const asDirector = await call('GET', `/api/v1/performance-dashboard?departmentId=${s.marketing}`, { token: s.admin.token });
    expect(asDirector.body.people.map((p: { user: { id: string } }) => p.user.id)).toContain(s.mkt.jefeNoGrant.id);
  });
});
