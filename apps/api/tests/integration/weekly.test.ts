import ExcelJS from 'exceljs';
import { prisma } from '../../src/lib/prisma';
import { addDays, mondayOf } from '../../src/lib/week';
import { flushNotifications } from '../../src/modules/notifications/notify.service';
import { ensureCurrentWeeks, MONTHLY_REVIEW_TITLE } from '../../src/modules/weeks/weeks.service';
import { createTask, seedWorkspace, WORKSPACE_TZ, type Seed } from './fixtures';
import { app, call, resetDatabase } from './helpers';

let s: Seed;

const thisMonday = () => mondayOf(new Date(), WORKSPACE_TZ);
const lastMonday = () => addDays(thisMonday(), -7);
const nextMonday = () => addDays(thisMonday(), 7);
// Noon in the workspace timezone on `monday` + `day`.
const on = (monday: string, day: number) => `${addDays(monday, day)}T17:00:00.000Z`;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});
afterAll(() => prisma.$disconnect());

async function openWeek(monday: string) {
  const res = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: monday } });
  if (res.status >= 300) throw new Error(`week failed: ${JSON.stringify(res.body)}`);
  // Month-end weeks get the monthly review task; tests that count tasks drop it.
  await prisma.task.deleteMany({ where: { sourceType: 'SYSTEM' } });
  return res.body.week as { id: string; mondayDate: string; weekNumber: number };
}

const kpiUrl = (dept: string) => `/api/v1/departments/${dept}/kpis`;
const fnUrl = (dept: string) => `/api/v1/departments/${dept}/functions`;

async function addKpi(dept: string, weekId: string, body: Record<string, unknown>, token = s.admin.token) {
  const res = await call('POST', kpiUrl(dept), { token, body: { weekId, type: 'RESULT', ...body } });
  if (res.status !== 201) throw new Error(`kpi failed: ${JSON.stringify(res.body)}`);
  return res.body.kpi as { id: string };
}

async function addFunction(dept: string, weekId: string, title: string) {
  const res = await call('POST', fnUrl(dept), { token: s.admin.token, body: { weekId, title } });
  if (res.status !== 201) throw new Error(`function failed: ${JSON.stringify(res.body)}`);
  return res.body.function as { id: string };
}

describe('weeks', () => {
  it('the current week exists once, whoever asks first', async () => {
    const [a, b] = await Promise.all([
      call('GET', '/api/v1/weeks/current', { token: s.mkt.user.token }),
      call('GET', '/api/v1/weeks/current', { token: s.fin.user.token }),
    ]);
    expect(a.body.week.id).toBe(b.body.week.id);
    expect(a.body.week).toMatchObject({ mondayDate: thisMonday(), saturdayDate: addDays(thisMonday(), 5), status: 'ACTIVE' });
    expect(await prisma.week.count()).toBe(1);
  });

  it('the scheduler opens each workspace week and tells the area heads', async () => {
    expect(await ensureCurrentWeeks()).toBe(1);
    expect(await ensureCurrentWeeks()).toBe(0);
    await flushNotifications();
    const notes = await prisma.notification.findMany({ where: { type: 'WEEK_STARTED' } });
    expect(notes.map((n) => n.userId).sort()).toEqual([s.fin.jefe.id, s.mkt.jefe.id, s.mkt.jefeNoGrant.id].sort());
  });

  it('a new week starts with last week’s KPIs and functions, results cleared', async () => {
    const past = await openWeek(lastMonday());
    const kpi = await addKpi(s.marketing, past.id, { title: 'Leads', target: 100, unit: 'leads' });
    await call('PATCH', `${kpiUrl(s.marketing)}/${kpi.id}`, { token: s.admin.token, body: { actual: 90 } });
    const fn = await addFunction(s.marketing, past.id, 'Reunión semanal');
    await call('PATCH', `${fnUrl(s.marketing)}/${fn.id}`, { token: s.admin.token, body: { fulfilled: 'YES' } });

    const current = (await call('GET', '/api/v1/weeks/current', { token: s.admin.token })).body.week;
    const kpis = (await call('GET', `${kpiUrl(s.marketing)}?weekId=${current.id}`, { token: s.mkt.user.token })).body.data;
    expect(kpis).toEqual([expect.objectContaining({ title: 'Leads', target: 100, unit: 'leads', actual: null, completion: null })]);
    const fns = (await call('GET', `${fnUrl(s.marketing)}?weekId=current`, { token: s.mkt.user.token })).body.data;
    expect(fns).toEqual([expect.objectContaining({ title: 'Reunión semanal', fulfilled: null })]);
  });

  it('the month’s last week gets an "Exponer resultados" task per area', async () => {
    await prisma.department.update({ where: { id: s.marketing }, data: { headId: s.mkt.jefe.id } });
    const plain = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: '2027-01-18' } });
    expect(plain.status).toBe(201);
    expect(await prisma.task.count({ where: { sourceType: 'SYSTEM' } })).toBe(0);

    const monthEnd = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: '2027-01-25' } });
    const tasks = await prisma.task.findMany({ where: { weekId: monthEnd.body.week.id, sourceType: 'SYSTEM' } });
    expect(tasks.map((t) => [t.departmentId, t.title, t.assignedToId]).sort()).toEqual(
      [
        [s.finanzas, MONTHLY_REVIEW_TITLE, null],
        [s.marketing, MONTHLY_REVIEW_TITLE, s.mkt.jefe.id],
      ].sort(),
    );
    expect(tasks[0]!.dueDate!.toISOString().slice(0, 10)).toBe('2027-01-30');

    expect((await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: '2027-01-26' } })).status).toBe(422);
    expect((await call('POST', '/api/v1/weeks', { token: s.mkt.jefe.token, body: {} })).status).toBe(403);
  });
});

describe('tasks in weeks', () => {
  it('a task joins the week of its day and moves with it', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Informe', assignedTo: s.mkt.user.id, dueDate: on(thisMonday(), 2) });
    expect(task.week).toMatchObject({ mondayDate: thisMonday(), status: 'ACTIVE' });

    const moved = await call('PATCH', `/api/v1/tasks/${task.id}`, { token: s.mkt.jefe.token, body: { dueDate: on(nextMonday(), 1) } });
    expect(moved.body.task.week.mondayDate).toBe(nextMonday());
    expect(moved.body.task.semaphore).toBe('GRAY');

    const undated = await createTask(s.mkt.jefe.token, { title: 'Sin fecha' });
    expect(undated.week.mondayDate).toBe(thisMonday());
    expect(undated.day).toBe(addDays(thisMonday(), 5)); // counts as due Saturday
  });

  it('PATCH /progress follows the 0/25/50/75/100 steps and turns a late task green at 100%', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Atrasada', assignedTo: s.mkt.user.id, dueDate: on(lastMonday(), 1) });
    expect(task.semaphore).toBe('RED');
    expect((await call('PATCH', `/api/v1/tasks/${task.id}/progress`, { token: s.mkt.user.token, body: { progress: 60 } })).status).toBe(422);
    expect((await call('PATCH', `/api/v1/tasks/${task.id}/progress`, { token: s.mkt.user2.token, body: { progress: 50 } })).status).toBe(403);
    const done = await call('PATCH', `/api/v1/tasks/${task.id}/progress`, { token: s.mkt.user.token, body: { progress: 100 } });
    expect(done.body.task).toMatchObject({ progress: 100, status: 'DONE', semaphore: 'GREEN' });
  });

  it('observations are per week, by the people who update the task', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Brief', assignedTo: s.mkt.user.id, dueDate: on(thisMonday(), 3) });
    const url = `/api/v1/tasks/${task.id}/observation`;
    expect((await call('PATCH', url, { token: s.mkt.viewer.token, body: { observation: 'x' } })).status).toBe(403);
    expect((await call('PATCH', url, { token: s.mkt.user.token, body: { observation: '  Falta el arte  ' } })).body).toEqual({ observation: 'Falta el arte' });

    const detail = await call('GET', `/api/v1/tasks/${task.id}`, { token: s.mkt.viewer.token });
    expect(detail.body.task.observation).toBe('Falta el arte');
    expect((await call('PATCH', url, { token: s.mkt.jefe.token, body: { observation: '' } })).body).toEqual({ observation: null });
    expect(await prisma.taskObservation.count()).toBe(0);

    const history = await call('GET', `/api/v1/tasks/${task.id}/history?limit=1`, { token: s.mkt.user.token });
    expect(history.body).toMatchObject({ total: 3, limit: 1 });
    expect(history.body.data[0]).toMatchObject({ action: 'TASK_OBSERVATION_SET', changes: { observation: { old: 'Falta el arte', new: null } } });
  });
});

describe('KPIs and functions', () => {
  it('only the area head or an ADMIN defines them', async () => {
    const week = (await call('GET', '/api/v1/weeks/current', { token: s.admin.token })).body.week;
    const body = { weekId: week.id, title: 'Leads', target: 100 };
    expect((await call('POST', kpiUrl(s.marketing), { token: s.mkt.jefe.token, body })).status).toBe(201);
    expect((await call('POST', kpiUrl(s.marketing), { token: s.mkt.user.token, body })).status).toBe(403);
    expect((await call('POST', kpiUrl(s.marketing), { token: s.fin.jefe.token, body })).status).toBe(404); // can't see it
    expect((await call('POST', kpiUrl(s.marketing), { token: s.mkt.viewer.token, body })).status).toBe(403);
    expect((await call('POST', fnUrl(s.marketing), { token: s.mkt.user.token, body: { title: 'Reunión' } })).status).toBe(403);
    expect((await call('GET', kpiUrl(s.marketing), { token: s.mkt.viewer.token })).body.data).toHaveLength(1);
  });

  it('validates targets: positive, or ≥ 0 when less is better', async () => {
    const week = (await call('GET', '/api/v1/weeks/current', { token: s.admin.token })).body.week;
    const post = (body: object) => call('POST', kpiUrl(s.marketing), { token: s.admin.token, body: { weekId: week.id, title: 'K', ...body } });
    expect((await post({ target: 0 })).status).toBe(422);
    expect((await post({ target: -5 })).status).toBe(422);
    expect((await post({ target: 0, lesserIsBetter: true })).status).toBe(201);
    expect((await post({ title: '', target: 10 })).status).toBe(422);
  });

  it('results are Saturday work for the area head; an ADMIN can correct any day', async () => {
    const future = await openWeek(nextMonday());
    const past = await openWeek(lastMonday());
    const early = await addKpi(s.marketing, future.id, { title: 'Leads', target: 100 });
    const due = await addKpi(s.marketing, past.id, { title: 'Leads', target: 100 });
    const fn = await addFunction(s.marketing, future.id, 'Reunión');

    const early1 = await call('PATCH', `${kpiUrl(s.marketing)}/${early.id}`, { token: s.mkt.jefe.token, body: { actual: 80 } });
    expect(early1.status).toBe(403);
    expect(early1.body.error.code).toBe('RESULTS_ON_SATURDAY');
    expect((await call('PATCH', `${fnUrl(s.marketing)}/${fn.id}`, { token: s.mkt.jefe.token, body: { fulfilled: 'YES' } })).status).toBe(403);
    // Editing the definition is fine any day.
    expect((await call('PATCH', `${kpiUrl(s.marketing)}/${early.id}`, { token: s.mkt.jefe.token, body: { target: 120 } })).status).toBe(200);

    const late = await call('PATCH', `${kpiUrl(s.marketing)}/${due.id}`, { token: s.mkt.jefe.token, body: { actual: 85 } });
    expect(late.body.kpi).toMatchObject({ actual: 85, completion: 0.85, semaphore: 'YELLOW' });
    expect((await call('PATCH', `${kpiUrl(s.marketing)}/${early.id}`, { token: s.admin.token, body: { actual: 130 } })).body.kpi).toMatchObject({
      completion: 1.0833,
      semaphore: 'GREEN',
    });
    expect((await call('PATCH', `${kpiUrl(s.marketing)}/${due.id}`, { token: s.mkt.user.token, body: { actual: 1 } })).status).toBe(403);

    const logs = await prisma.activityLog.findMany({ where: { entityType: 'Kpi', entityId: due.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['KPI_CREATED', 'KPI_RECORDED']);
  });

  it('computes completion, "less is better" and the trend against last week', async () => {
    const previous = await openWeek(addDays(lastMonday(), -7));
    await addKpi(s.finanzas, previous.id, { title: 'Recaudos', target: 100 });
    await prisma.kpi.updateMany({ where: { weekId: previous.id }, data: { actual: 80 } });
    const past = await openWeek(lastMonday());
    // The next week inherited "Recaudos"; add a "less is better" KPI too.
    const [recaudos] = await prisma.kpi.findMany({ where: { weekId: past.id } });
    await call('PATCH', `${kpiUrl(s.finanzas)}/${recaudos!.id}`, { token: s.admin.token, body: { actual: 95 } });
    const tardanzas = await addKpi(s.finanzas, past.id, { title: 'Tardanzas', target: 5, lesserIsBetter: true });
    await call('PATCH', `${kpiUrl(s.finanzas)}/${tardanzas.id}`, { token: s.admin.token, body: { actual: 10 } });

    const list = await call('GET', `${kpiUrl(s.finanzas)}?weekId=${past.id}`, { token: s.fin.user.token });
    expect(list.body.data).toEqual([
      expect.objectContaining({ title: 'Recaudos', completion: 0.95, semaphore: 'GREEN', trend: 'UP' }),
      expect.objectContaining({ title: 'Tardanzas', completion: 0.5, semaphore: 'RED', trend: null }),
    ]);
    expect(list.body.kpiCompliance).toBe(0.725);
  });

  it('templates offer earlier KPI definitions of visible areas', async () => {
    const week = (await call('GET', '/api/v1/weeks/current', { token: s.admin.token })).body.week;
    await addKpi(s.marketing, week.id, { title: 'Leads', target: 100 });
    await addKpi(s.finanzas, week.id, { title: 'Recaudos', target: 5000 });
    const mine = await call('GET', '/api/v1/kpis/templates', { token: s.mkt.jefe.token });
    expect(mine.body.data.map((t: { title: string }) => t.title)).toEqual(['Leads']);
  });
});

describe('dashboard', () => {
  // Last week: every task already due, so the numbers are fixed.
  async function prepareLastWeek() {
    const week = await openWeek(lastMonday());
    const a = await createTask(s.mkt.jefe.token, { title: 'A', assignedTo: s.mkt.user.id, dueDate: on(week.mondayDate, 0) });
    const b = await createTask(s.mkt.jefe.token, { title: 'B', assignedTo: s.mkt.user.id, dueDate: on(week.mondayDate, 2) });
    await createTask(s.fin.jefe.token, { title: 'F', dueDate: on(week.mondayDate, 1) });
    await call('PATCH', `/api/v1/tasks/${a.id}/progress`, { token: s.mkt.user.token, body: { progress: 100 } });
    await call('PATCH', `/api/v1/tasks/${b.id}/progress`, { token: s.mkt.user.token, body: { progress: 50 } });
    const k1 = await addKpi(s.marketing, week.id, { title: 'Leads', target: 100 });
    const k2 = await addKpi(s.marketing, week.id, { title: 'Posts', target: 15 });
    await call('PATCH', `${kpiUrl(s.marketing)}/${k1.id}`, { token: s.admin.token, body: { actual: 85 } });
    await call('PATCH', `${kpiUrl(s.marketing)}/${k2.id}`, { token: s.admin.token, body: { actual: 18 } });
    const f1 = await addFunction(s.marketing, week.id, 'Reunión');
    const f2 = await addFunction(s.marketing, week.id, 'Reporte');
    await call('PATCH', `${fnUrl(s.marketing)}/${f1.id}`, { token: s.admin.token, body: { fulfilled: 'YES' } });
    await call('PATCH', `${fnUrl(s.marketing)}/${f2.id}`, { token: s.admin.token, body: { fulfilled: 'NO' } });
    return { week, a, b };
  }

  it('computes ①②③ and the index per area and for the company', async () => {
    const { week } = await prepareLastWeek();
    const res = await call('GET', `/api/v1/dashboard/week/${week.id}`, { token: s.admin.token });
    expect(res.status).toBe(200);
    const mkt = res.body.departments.find((d: { id: string }) => d.id === s.marketing);
    expect(mkt).toMatchObject({ taskProgress: 0.75, kpiCompliance: 0.925, functionCompliance: 0.5, index: 0.725, semaphore: 'YELLOW' });
    expect(mkt.tasks).toEqual({ total: 2, due: 2, done: 1, overdue: 1, blocked: 0 });
    const fin = res.body.departments.find((d: { id: string }) => d.id === s.finanzas);
    expect(fin).toMatchObject({ taskProgress: 0, kpiCompliance: null, index: 0, semaphore: 'RED' });

    expect(res.body.cards).toMatchObject({
      index: 0.3625, // (0.725 + 0) / 2: every area weighs the same
      semaphore: 'RED',
      totalTasks: 3,
      doneTasks: 1,
      overdueTasks: 2,
      taskProgress: 0.375,
      kpiCompliance: 0.925,
      functionCompliance: 0.5,
      areasBySemaphore: { GREEN: 0, YELLOW: 1, RED: 1, NONE: 0 },
    });
    expect(res.body.charts.taskSemaphore).toEqual({ GREEN: 1, YELLOW: 0, RED: 2, GRAY: 0 });
    expect(res.body.charts.criticalKpis.map((k: { title: string }) => k.title)).toEqual(['Leads']);
  });

  it('shows each person only the areas they can see', async () => {
    const { week } = await prepareLastWeek();
    const asUser = await call('GET', `/api/v1/dashboard/week/${week.id}`, { token: s.fin.user.token });
    expect(asUser.body.departments.map((d: { name: string }) => d.name)).toEqual(['Finanzas']);
    expect((await call('GET', `/api/v1/dashboard/week/${week.id}?departmentId=${s.marketing}`, { token: s.fin.user.token })).status).toBe(404);

    const area = await call('GET', `/api/v1/dashboard/department/${s.marketing}/week/${week.id}`, { token: s.mkt.viewer.token });
    expect(area.body.department.tasks.map((t: { title: string; semaphore: string }) => [t.title, t.semaphore])).toEqual([
      ['A', 'GREEN'],
      ['B', 'RED'],
    ]);
    expect(area.body.department.kpis).toHaveLength(2);
    expect((await call('GET', `/api/v1/dashboard/department/${s.marketing}/week/${week.id}`, { token: s.fin.user.token })).status).toBe(404);
  });

  it('trends list the index week by week, ending with the current one', async () => {
    await prepareLastWeek();
    const res = await call('GET', '/api/v1/dashboard/trends?weeks=4', { token: s.admin.token });
    expect(res.body.data.map((p: { week: { mondayDate: string } }) => p.week.mondayDate)).toEqual([lastMonday(), thisMonday()]);
    expect(res.body.data[0].index).toBe(0.3625);
    const mkt = await call('GET', `/api/v1/dashboard/trends?departmentId=${s.marketing}`, { token: s.admin.token });
    expect(mkt.body.data[0].index).toBe(0.725);
  });

  it('exports the week to Excel with a title block and one row per area', async () => {
    const { week } = await prepareLastWeek();
    const res = await app.request(`/api/v1/dashboard/export/excel?weekId=${week.id}`, { headers: { authorization: `Bearer ${s.admin.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toContain(`DashboardCentralPartner_Week${week.weekNumber}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'Tareas', 'KPIs', 'Funciones']);
    const summary = wb.getWorksheet('Resumen')!;
    expect(summary.getCell('A1').value).toBe('Central Partner - Dashboard');
    expect(String(summary.getCell('A2').value)).toMatch(new RegExp(`^Semana ${week.weekNumber} .*Todas las áreas · Generado: `));
    expect(summary.getRow(4).values).toEqual(expect.arrayContaining(['Área', 'Jefe', 'Total Tareas', '% Completadas', 'Atrasadas', 'Índice']));
    expect(summary.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
    const rows = summary.getRows(5, 3)!;
    const marketing = rows.find((r) => r.getCell(1).value === 'Marketing')!;
    expect(marketing.getCell(4).value).toBe(0.5); // 1 of 2 done
    expect(marketing.getCell(9).value).toBe(0.725);
    expect(rows.map((r) => r.getCell(1).value)).toContain('TOTAL EMPRESA');
  });

  it('POST /export/excel honors the area filter and rejects other workspaces and hidden areas', async () => {
    const { week } = await prepareLastWeek();
    const post = (token: string, body: object) =>
      app.request('/api/v1/dashboard/export/excel', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const res = await post(s.admin.token, { weekId: week.id, areaId: s.marketing, format: 'xlsx' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`_Week${week.weekNumber}_Marketing.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const summary = wb.getWorksheet('Resumen')!;
    expect(String(summary.getCell('A2').value)).toContain('Área: Marketing');
    expect(summary.getRows(5, 5)!.map((r) => r.getCell(1).value).filter(Boolean)).toEqual(['Marketing']);
    expect(wb.getWorksheet('Tareas')!.getRows(5, 5)!.map((r) => r.getCell(1).value).filter(Boolean)).toEqual(['Marketing', 'Marketing']);

    expect((await post(s.admin.token, { workspaceId: crypto.randomUUID() })).status).toBe(404);
    expect((await post(s.fin.user.token, { areaId: s.marketing })).status).toBe(404);
    expect((await post(s.admin.token, { weekId: crypto.randomUUID() })).status).toBe(404);
    expect((await post(s.admin.token, { format: 'csv' })).status).toBe(422);
  });

  it('history returns the last closed weeks plus the current one, in percentages', async () => {
    const { week } = await prepareLastWeek();
    await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });
    const res = await call('GET', '/api/v1/dashboard/week/history?limit=3', { token: s.admin.token });
    expect(res.status).toBe(200);
    expect(res.body.weeks.map((w: { mondayDate: string; status: string }) => [w.mondayDate, w.status])).toEqual([
      [lastMonday(), 'ARCHIVED'],
      [thisMonday(), 'ACTIVE'],
    ]);
    const [closed] = res.body.weeks;
    expect(closed.metrics).toMatchObject({ indexGeneral: 36.3, totalTasks: 3, completedTasks: 1, delayedTasks: 2, compliancePercentage: 33.3 });
    const mkt = closed.departmentMetrics.find((d: { departmentName: string }) => d.departmentName === 'Marketing');
    expect(mkt).toMatchObject({ tasksTotal: 2, tasksCompleted: 1, tasksDelayed: 1, kpiIndex: 72.5, semaphore: 'YELLOW' });

    const area = await call('GET', `/api/v1/dashboard/week/history?departmentId=${s.marketing}&includeCurrent=false`, { token: s.admin.token });
    expect(area.body.weeks).toHaveLength(1);
    expect(area.body.weeks[0].metrics).toMatchObject({ indexGeneral: 72.5, totalTasks: 2, compliancePercentage: 50 });
    expect((await call('GET', `/api/v1/dashboard/week/history?departmentId=${s.marketing}`, { token: s.fin.user.token })).status).toBe(404);
  });
});

describe('closing a week', () => {
  it('reports what is missing and needs confirmation to close anyway', async () => {
    const week = await openWeek(lastMonday());
    await createTask(s.mkt.jefe.token, { title: 'Sin tocar', dueDate: on(week.mondayDate, 1) });
    const check = await call('GET', `/api/v1/weeks/${week.id}/closure-check`, { token: s.admin.token });
    const mkt = check.body.departments.find((d: { departmentId: string }) => d.departmentId === s.marketing);
    expect(mkt).toMatchObject({ tasksWithoutProgress: 1, noKpis: true, noFunctions: true, complete: false });
    expect(check.body.incompleteCount).toBe(2);

    expect((await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.mkt.jefe.token })).status).toBe(403);
    const refused = await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('WEEK_INCOMPLETE');
    expect(refused.body.error.details.incompleteCount).toBe(2);
    expect((await prisma.week.findUniqueOrThrow({ where: { id: week.id } })).status).toBe('ACTIVE');
  });

  it('archives the week, freezes its numbers and carries unfinished tasks to the next week', async () => {
    const week = await openWeek(lastMonday());
    const done = await createTask(s.mkt.jefe.token, { title: 'Hecha', assignedTo: s.mkt.user.id, dueDate: on(week.mondayDate, 0) });
    const open = await createTask(s.mkt.jefe.token, { title: 'Pendiente', assignedTo: s.mkt.user.id, dueDate: on(week.mondayDate, 1) });
    await call('PATCH', `/api/v1/tasks/${done.id}/progress`, { token: s.mkt.user.token, body: { progress: 100 } });
    await call('PATCH', `/api/v1/tasks/${open.id}/progress`, { token: s.mkt.user.token, body: { progress: 50 } });
    const kpi = await addKpi(s.marketing, week.id, { title: 'Leads', target: 100 });
    await call('PATCH', `${kpiUrl(s.marketing)}/${kpi.id}`, { token: s.admin.token, body: { actual: 90 } });

    const closed = await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ week: { status: 'ARCHIVED' }, nextWeek: { mondayDate: thisMonday() }, carriedTasks: 1 });

    const carried = await call('GET', `/api/v1/tasks/${open.id}`, { token: s.mkt.user.token });
    expect(carried.body.task).toMatchObject({ week: { mondayDate: thisMonday() }, carriedFrom: { weekNumber: week.weekNumber }, progress: 50 });
    expect(carried.body.permissions.weekOpen).toBe(true);
    // The next week starts with this week's KPIs.
    expect(await prisma.kpi.count({ where: { weekId: closed.body.nextWeek.id, title: 'Leads', actual: null } })).toBe(1);

    // The archive is frozen: later changes don't alter it.
    const before = (await call('GET', `/api/v1/dashboard/week/${week.id}`, { token: s.admin.token })).body;
    expect(before.departments.find((d: { id: string }) => d.id === s.marketing)).toMatchObject({ taskProgress: 0.75, kpiCompliance: 0.9 });
    await call('PATCH', `/api/v1/tasks/${open.id}/progress`, { token: s.mkt.user.token, body: { progress: 100 } });
    const after = (await call('GET', `/api/v1/dashboard/week/${week.id}`, { token: s.admin.token })).body;
    expect(after.departments).toEqual(before.departments);
    expect(await prisma.weeklyArchive.count({ where: { weekId: week.id } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { action: 'WEEK_CLOSED', entityId: week.id } })).toBe(1);

    expect((await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } })).body.error.code).toBe('WEEK_ARCHIVED');
  });

  it('an archived week is read-only', async () => {
    const week = await openWeek(lastMonday());
    const done = await createTask(s.mkt.jefe.token, { title: 'Hecha', assignedTo: s.mkt.user.id, dueDate: on(week.mondayDate, 0) });
    await call('PATCH', `/api/v1/tasks/${done.id}/progress`, { token: s.mkt.user.token, body: { progress: 100 } });
    const kpi = await addKpi(s.marketing, week.id, { title: 'Leads', target: 100 });
    const fn = await addFunction(s.marketing, week.id, 'Reunión');
    await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });

    const blocked = [
      await call('PATCH', `/api/v1/tasks/${done.id}`, { token: s.admin.token, body: { title: 'Otra' } }),
      await call('PATCH', `/api/v1/tasks/${done.id}/observation`, { token: s.mkt.user.token, body: { observation: 'x' } }),
      await call('DELETE', `/api/v1/tasks/${done.id}`, { token: s.admin.token }),
      await call('POST', `/api/v1/tasks/${done.id}/comments`, { token: s.mkt.user.token, body: { content: 'hola' } }),
      await call('PATCH', `${kpiUrl(s.marketing)}/${kpi.id}`, { token: s.admin.token, body: { actual: 1 } }),
      await call('PATCH', `${fnUrl(s.marketing)}/${fn.id}`, { token: s.admin.token, body: { fulfilled: 'YES' } }),
      await call('POST', kpiUrl(s.marketing), { token: s.admin.token, body: { weekId: week.id, title: 'Nuevo', target: 1 } }),
    ];
    expect(blocked.map((r) => [r.status, r.body.error.code])).toEqual(Array(7).fill([409, 'WEEK_ARCHIVED']));
    // …and nothing can be scheduled into it.
    const create = await call('POST', '/api/v1/tasks', { token: s.admin.token, body: { title: 'Tarde', departmentId: s.marketing, dueDate: on(week.mondayDate, 2) } });
    expect(create.status).toBe(422);

    const detail = await call('GET', `/api/v1/tasks/${done.id}`, { token: s.admin.token });
    expect(detail.body.permissions).toEqual({ canEdit: false, canComment: false, canAddFiles: false, canDelete: false, weekOpen: false });
  });

  it('a task carried twice keeps the week it first came from', async () => {
    const first = await openWeek(addDays(lastMonday(), -7));
    const task = await createTask(s.mkt.jefe.token, { title: 'Eterna', dueDate: on(first.mondayDate, 0) });
    await call('POST', `/api/v1/weeks/${first.id}/close`, { token: s.admin.token, body: { force: true } });
    const second = (await call('GET', `/api/v1/tasks/${task.id}`, { token: s.admin.token })).body.task.week;
    expect(second.mondayDate).toBe(lastMonday());
    await call('POST', `/api/v1/weeks/${second.id}/close`, { token: s.admin.token, body: { force: true } });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { week: true } });
    expect(row.carriedFromWeekId).toBe(first.id);
    expect(row.week!.weekNumber).toBe((await prisma.week.findFirstOrThrow({ where: { status: 'ACTIVE', mondayDate: new Date(`${thisMonday()}T00:00:00Z`) } })).weekNumber);
  });
});

describe('workspace settings', () => {
  it('an ADMIN sets the timezone that defines the weeks', async () => {
    const url = `/api/v1/workspaces/${s.workspaceId}/settings`;
    expect((await call('GET', url, { token: s.mkt.user.token })).body).toEqual({ settings: { timezone: 'America/Lima' } });
    expect((await call('PATCH', url, { token: s.mkt.jefe.token, body: { timezone: 'Europe/Madrid' } })).status).toBe(403);
    expect((await call('PATCH', url, { token: s.admin.token, body: { timezone: 'Mars/Olympus' } })).status).toBe(422);
    expect((await call('PATCH', url, { token: s.admin.token, body: { timezone: 'America/Bogota' } })).status).toBe(200);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } })).timezone).toBe('America/Bogota');
  });
});
