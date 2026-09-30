import ExcelJS from 'exceljs';
import { notFound } from '../../lib/errors';
import { canSeeDepartment, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import type { WeekData, WeekDepartment } from '../weeks/week-data';
import { currentWeek, presentWeek, resolveWeek, weekData } from '../weeks/weeks.service';

// The director's view of a week: company cards, the per-area table, the data
// behind the four charts, and the Excel export. Archived weeks come from their
// frozen snapshot; the open week is computed live.

const STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;
const TASK_SEMAPHORES = ['GREEN', 'YELLOW', 'RED', 'GRAY'] as const;

function areaRow(d: WeekDepartment) {
  return {
    id: d.id,
    name: d.name,
    color: d.color,
    head: d.head,
    tasks: d.metrics.tasks,
    kpis: d.metrics.kpis,
    functions: d.metrics.functions,
    taskProgress: d.metrics.taskProgress,
    kpiCompliance: d.metrics.kpiCompliance,
    functionCompliance: d.metrics.functionCompliance,
    index: d.metrics.index,
    semaphore: d.metrics.semaphore,
  };
}

function summarize(data: WeekData) {
  const tasks = data.departments.flatMap((d) => d.tasks);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const bySemaphore = Object.fromEntries(TASK_SEMAPHORES.map((s) => [s, tasks.filter((t) => t.semaphore === s).length]));
  // KPIs already recorded and below 90%, worst first.
  const criticalKpis = data.departments
    .flatMap((d) => d.kpis.filter((k) => k.semaphore === 'RED' || k.semaphore === 'YELLOW').map((k) => ({ ...k, department: { id: d.id, name: d.name } })))
    .sort((a, b) => (a.completion ?? 0) - (b.completion ?? 0))
    .slice(0, 10);
  return { byStatus, bySemaphore, criticalKpis };
}

async function scopedWeekData(user: AuthUser, weekRef: string | undefined, departmentId?: string) {
  const week = await resolveWeek(user, weekRef);
  const data = await weekData(user, week);
  if (departmentId) {
    const scope = await departmentScope(user);
    if (!canSeeDepartment(scope, departmentId)) throw notFound('Department');
    data.departments = data.departments.filter((d) => d.id === departmentId);
  }
  return { week, data };
}

export async function weekDashboard(user: AuthUser, weekRef: string | undefined, departmentId?: string) {
  const { week, data } = await scopedWeekData(user, weekRef, departmentId);
  const { byStatus, bySemaphore, criticalKpis } = summarize(data);
  // With a department filter the "company" cards describe just that area.
  const overall = departmentId ? { ...data.overall, ...pickOverall(data.departments[0]) } : data.overall;
  return {
    week: { ...data.week, archivedAt: week.archivedAt },
    today: data.today,
    cards: {
      index: overall.index,
      semaphore: overall.semaphore,
      totalTasks: overall.tasks.total,
      doneTasks: overall.tasks.done,
      overdueTasks: overall.tasks.overdue,
      blockedTasks: overall.tasks.blocked,
      taskProgress: overall.taskProgress,
      kpiCompliance: overall.kpiCompliance,
      functionCompliance: overall.functionCompliance,
      areasBySemaphore: overall.areasBySemaphore,
    },
    departments: data.departments.map(areaRow),
    charts: { taskStatus: byStatus, taskSemaphore: bySemaphore, criticalKpis },
    generatedAt: data.generatedAt,
  };
}

function pickOverall(d: WeekDepartment | undefined) {
  if (!d) return {};
  const m = d.metrics;
  return {
    taskProgress: m.taskProgress,
    kpiCompliance: m.kpiCompliance,
    functionCompliance: m.functionCompliance,
    index: m.index,
    semaphore: m.semaphore,
    tasks: m.tasks,
    areasBySemaphore: { GREEN: 0, YELLOW: 0, RED: 0, NONE: 0, [m.semaphore ?? 'NONE']: 1 },
  };
}

// The area sheet: its tasks, KPIs and functions for the week, with its index.
export async function departmentWeek(user: AuthUser, departmentId: string, weekRef: string | undefined) {
  const { week, data } = await scopedWeekData(user, weekRef, departmentId);
  const department = data.departments[0];
  if (!department) throw notFound('Department');
  return { week: { ...data.week, archivedAt: week.archivedAt }, today: data.today, department };
}

// The index week by week, oldest first, ending with the current week.
export async function trends(user: AuthUser, count: number, departmentId?: string) {
  const current = await currentWeek(user.workspaceId, user.workspaceTimezone);
  const weeks = await prisma.week.findMany({
    where: { workspaceId: user.workspaceId, mondayDate: { lte: current.mondayDate } },
    orderBy: { mondayDate: 'desc' },
    take: count,
  });
  const scope = departmentId ? await departmentScope(user) : null;
  if (departmentId && !canSeeDepartment(scope!, departmentId)) throw notFound('Department');

  const points = [];
  for (const week of weeks.reverse()) {
    const data = await weekData(user, week);
    const departments = data.departments.filter((d) => !departmentId || d.id === departmentId);
    const focus = departmentId ? departments[0]?.metrics : null;
    points.push({
      week: presentWeek(week),
      index: focus ? focus.index : data.overall.index,
      taskProgress: focus ? focus.taskProgress : data.overall.taskProgress,
      kpiCompliance: focus ? focus.kpiCompliance : data.overall.kpiCompliance,
      functionCompliance: focus ? focus.functionCompliance : data.overall.functionCompliance,
      semaphore: focus ? focus.semaphore : data.overall.semaphore,
      departments: departments.map((d) => ({ id: d.id, name: d.name, index: d.metrics.index, semaphore: d.metrics.semaphore })),
    });
  }
  return { data: points };
}

// ─── Excel export ───────────────────────────────────────────────────────────

const SEMAPHORE_ES: Record<string, string> = { GREEN: 'Verde', YELLOW: 'Amarillo', RED: 'Rojo', GRAY: 'Gris' };
const FULFILLED_ES: Record<string, string> = { YES: 'Sí', PARTIAL: 'Parcial', NO: 'No', NOT_APPLICABLE: 'No aplica' };
const FILL: Record<string, string> = { GREEN: 'FFDCFCE7', YELLOW: 'FFFEF9C3', RED: 'FFFEE2E2', GRAY: 'FFF1F5F9' };
const pct = (v: number | null) => (v === null ? null : v);

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function paint(cell: ExcelJS.Cell, semaphore: string | null) {
  if (semaphore && FILL[semaphore]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[semaphore] } };
}

export async function exportWeekExcel(user: AuthUser, weekRef: string | undefined) {
  const { data } = await scopedWeekData(user, weekRef);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Central Partner';
  wb.created = new Date();
  const label = `Semana ${data.week.weekNumber} (${data.week.mondayDate} al ${data.week.saturdayDate})`;

  const summary = wb.addWorksheet('Resumen');
  summary.columns = [
    { header: 'Área', key: 'name', width: 24 },
    { header: 'Jefe', key: 'head', width: 22 },
    { header: 'Tareas', key: 'total', width: 9 },
    { header: 'Cumplidas', key: 'done', width: 11 },
    { header: 'Atrasadas', key: 'overdue', width: 11 },
    { header: 'Bloqueadas', key: 'blocked', width: 11 },
    { header: '① Avance', key: 'taskProgress', width: 11, style: { numFmt: '0.0%' } },
    { header: '② KPIs', key: 'kpiCompliance', width: 10, style: { numFmt: '0.0%' } },
    { header: '③ Funciones', key: 'functionCompliance', width: 12, style: { numFmt: '0.0%' } },
    { header: 'Índice', key: 'index', width: 10, style: { numFmt: '0.0%' } },
    { header: 'Semáforo', key: 'semaphore', width: 11 },
    { header: 'KPIs registrados', key: 'kpis', width: 16 },
    { header: 'Funciones marcadas', key: 'functions', width: 18 },
  ];
  for (const d of data.departments) {
    const m = d.metrics;
    const row = summary.addRow({
      name: d.name,
      head: d.head?.displayName ?? '—',
      total: m.tasks.total,
      done: m.tasks.done,
      overdue: m.tasks.overdue,
      blocked: m.tasks.blocked,
      taskProgress: pct(m.taskProgress),
      kpiCompliance: pct(m.kpiCompliance),
      functionCompliance: pct(m.functionCompliance),
      index: pct(m.index),
      semaphore: m.semaphore ? SEMAPHORE_ES[m.semaphore] : '—',
      kpis: `${m.kpis.recorded}/${m.kpis.total}`,
      functions: `${m.functions.marked}/${m.functions.total}`,
    });
    paint(row.getCell('semaphore'), m.semaphore);
  }
  const o = data.overall;
  const total = summary.addRow({
    name: 'TOTAL EMPRESA',
    total: o.tasks.total,
    done: o.tasks.done,
    overdue: o.tasks.overdue,
    blocked: o.tasks.blocked,
    taskProgress: pct(o.taskProgress),
    kpiCompliance: pct(o.kpiCompliance),
    functionCompliance: pct(o.functionCompliance),
    index: pct(o.index),
    semaphore: o.semaphore ? SEMAPHORE_ES[o.semaphore] : '—',
  });
  total.font = { bold: true };
  paint(total.getCell('semaphore'), o.semaphore);
  styleHeader(summary);
  summary.addRow([]);
  summary.addRow([label]).font = { italic: true, color: { argb: 'FF7A8092' } };

  const tasks = wb.addWorksheet('Tareas');
  tasks.columns = [
    { header: 'Área', key: 'area', width: 20 },
    { header: 'Día', key: 'day', width: 12 },
    { header: 'Tarea', key: 'title', width: 44 },
    { header: 'Responsable', key: 'assignee', width: 22 },
    { header: '% Avance', key: 'progress', width: 10, style: { numFmt: '0%' } },
    { header: 'Estado', key: 'semaphore', width: 11 },
    { header: 'Viene de', key: 'carried', width: 11 },
    { header: 'Observación', key: 'observation', width: 40 },
  ];
  for (const d of data.departments) {
    for (const t of d.tasks) {
      const row = tasks.addRow({
        area: d.name,
        day: t.day ?? '',
        title: t.title,
        assignee: t.assignedTo?.displayName ?? 'Sin asignar',
        progress: t.progress / 100,
        semaphore: SEMAPHORE_ES[t.semaphore],
        carried: t.carriedFrom ? `Sem. ${t.carriedFrom.weekNumber}` : '',
        observation: t.observation ?? '',
      });
      paint(row.getCell('semaphore'), t.semaphore);
    }
  }
  styleHeader(tasks);

  const kpis = wb.addWorksheet('KPIs');
  kpis.columns = [
    { header: 'Área', key: 'area', width: 20 },
    { header: 'KPI', key: 'title', width: 36 },
    { header: 'Tipo', key: 'type', width: 14 },
    { header: 'Meta', key: 'target', width: 12 },
    { header: 'Real', key: 'actual', width: 12 },
    { header: 'Unidad', key: 'unit', width: 10 },
    { header: 'Menos es mejor', key: 'lesser', width: 15 },
    { header: '% Cumplimiento', key: 'completion', width: 15, style: { numFmt: '0.0%' } },
    { header: 'Semáforo', key: 'semaphore', width: 11 },
    { header: 'Tendencia', key: 'trend', width: 11 },
  ];
  const TYPE_ES: Record<string, string> = { RESULT: 'Resultado', COMPLIANCE: 'Cumplimiento', PROGRESS: 'Avance' };
  const TREND_ES: Record<string, string> = { UP: '↑', DOWN: '↓', STABLE: '=' };
  for (const d of data.departments) {
    for (const k of d.kpis) {
      const row = kpis.addRow({
        area: d.name,
        title: k.title,
        type: TYPE_ES[k.type] ?? k.type,
        target: k.target,
        actual: k.actual,
        unit: k.unit ?? '',
        lesser: k.lesserIsBetter ? 'Sí' : 'No',
        completion: k.completion,
        semaphore: k.semaphore ? SEMAPHORE_ES[k.semaphore] : '—',
        trend: k.trend ? TREND_ES[k.trend] : '',
      });
      paint(row.getCell('semaphore'), k.semaphore);
    }
  }
  styleHeader(kpis);

  const functions = wb.addWorksheet('Funciones');
  functions.columns = [
    { header: 'Área', key: 'area', width: 20 },
    { header: 'Función', key: 'title', width: 40 },
    { header: 'Frecuencia', key: 'frequency', width: 14 },
    { header: '¿Cumplió?', key: 'fulfilled', width: 12 },
    { header: 'Observación', key: 'observation', width: 40 },
  ];
  const FREQ_ES: Record<string, string> = { DAILY: 'Diaria', WEEKLY: 'Semanal', MONTHLY: 'Mensual', WHEN_OCCURS: 'Cuando ocurra', WHEN_CHANGES: 'Cuando cambie' };
  for (const d of data.departments) {
    for (const f of d.functions) {
      functions.addRow({
        area: d.name,
        title: f.title,
        frequency: FREQ_ES[f.frequency] ?? f.frequency,
        fulfilled: f.fulfilled ? FULFILLED_ES[f.fulfilled] : '—',
        observation: f.observation ?? '',
      });
    }
  }
  styleHeader(functions);

  const buffer = new Uint8Array(await wb.xlsx.writeBuffer());
  return { buffer, filename: `central-partner-semana-${data.week.year}-${String(data.week.weekNumber).padStart(2, '0')}.xlsx` };
}
