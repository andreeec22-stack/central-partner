import ExcelJS from 'exceljs';
import { buildWeeklyReport, estimateRows, sheetName, type HistoryWeek } from '../../src/modules/reports/report-workbook';
import { reportStatus } from '../../src/modules/reports/reports.service';
import type { WeekData, WeekDepartment } from '../../src/modules/weeks/week-data';

function dept(id: string, name: string, index: number | null, extra: Partial<WeekDepartment> = {}): WeekDepartment {
  return {
    id,
    name,
    color: null,
    head: { id: `h-${id}`, displayName: `Jefe ${name}` },
    metrics: {
      tasks: { total: 2, due: 2, done: 1, overdue: 1, blocked: 0 },
      kpis: { total: 1, recorded: 1 },
      functions: { total: 1, marked: 1 },
      taskProgress: index,
      kpiCompliance: index,
      functionCompliance: index,
      index,
      semaphore: index === null ? null : index >= 0.9 ? 'GREEN' : index >= 0.7 ? 'YELLOW' : 'RED',
    },
    tasks: [
      { id: `${id}-t1`, title: 'Diseño de campaña ñandú', status: 'DONE', priority: 'MEDIUM', progress: 100, dueDate: null, day: '2026-09-28', semaphore: 'GREEN', blockReason: null, assignedTo: { id: 'u', displayName: 'Ana Gómez' }, carriedFrom: null, sourceType: 'MANUAL', observation: null },
      { id: `${id}-t2`, title: 'Conciliación atrasada', status: 'IN_PROGRESS', priority: 'HIGH', progress: 50, dueDate: null, day: '2026-09-29', semaphore: 'RED', blockReason: null, assignedTo: null, carriedFrom: null, sourceType: 'MANUAL', observation: null },
    ],
    kpis: [{ id: `${id}-k`, title: 'Ventas', description: null, type: 'RESULT', unit: 'S/', target: 100, actual: 80, lesserIsBetter: false, order: 0, completion: 0.8, semaphore: 'YELLOW', trend: null, recordedAt: null }],
    functions: [{ id: `${id}-f`, title: 'Cierre de caja', description: null, frequency: 'DAILY', fulfilled: 'YES', observation: null, order: 0, markedAt: null }],
    ...extra,
  };
}

function weekData(departments: WeekDepartment[]): WeekData {
  return {
    week: { id: 'w40', mondayDate: '2026-09-28', saturdayDate: '2026-10-03', weekNumber: 40, year: 2026, status: 'ARCHIVED' },
    today: '2026-10-03',
    departments,
    overall: {
      taskProgress: 0.8,
      kpiCompliance: 0.8,
      functionCompliance: 0.8,
      index: 0.8,
      semaphore: 'YELLOW',
      tasks: { total: 28, due: 28, done: 14, overdue: 14, blocked: 0 },
      areasBySemaphore: { GREEN: 1, YELLOW: 1, RED: 1, NONE: 0 },
    },
    generatedAt: new Date('2026-10-03T15:00:00Z'),
  };
}

const history = (ids: string[]): HistoryWeek[] =>
  [38, 39, 40].map((n, i) => ({ weekNumber: n, year: 2026, mondayDate: `2026-09-${14 + i * 7}`, overall: 0.7 + i * 0.05, byDepartment: Object.fromEntries(ids.map((id) => [id, 0.6 + i * 0.1])) }));

describe('weekly report workbook', () => {
  it('has Resumen, one sheet per area, Histórico and Notas (14 areas → 17 sheets)', () => {
    const departments = Array.from({ length: 14 }, (_, i) => dept(`d${i}`, `Área ${i + 1}`, 0.5 + i * 0.03));
    const { workbook, sheetCount, rowCount } = buildWeeklyReport({ workspaceName: 'Central Partner', data: weekData(departments), history: history(departments.map((d) => d.id)), generatedAt: '3 oct 2026', generatedBy: 'Directora', source: 'MANUAL' });
    expect(sheetCount).toBe(17);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Resumen', ...departments.map((d) => d.name), 'Histórico', 'Notas']);
    expect(rowCount).toBeGreaterThan(14 * 10);
  });

  it('ranks the top and bottom 3 by index without repeating areas', async () => {
    const departments = [dept('a', 'Alta', 0.95), dept('b', 'Media', 0.8), dept('c', 'Baja', 0.4), dept('d', 'Muy baja', 0.2), dept('e', 'Sin datos', null)];
    const { workbook } = buildWeeklyReport({ workspaceName: 'CP', data: weekData(departments), history: [], generatedAt: 'x', generatedBy: null, source: 'WEEK_CLOSED' });
    const texts = (workbook.getWorksheet('Resumen')!.getSheetValues() as unknown[][]).map((r) => (r ? r.slice(1).join('|') : ''));
    const top = texts.indexOf('Top 3 áreas');
    const bottom = texts.indexOf('Bottom 3 áreas');
    expect(texts.slice(top + 2, top + 5).map((t) => t.split('|')[0])).toEqual(['Alta', 'Media', 'Baja']);
    // Only "Muy baja" is left once the top 3 are taken.
    expect(texts.slice(bottom + 2, bottom + 3).map((t) => t.split('|')[0])).toEqual(['Muy baja']);
  });

  it('E2.3: accents and ñ survive a write/read round trip', async () => {
    const { workbook } = buildWeeklyReport({ workspaceName: 'Café Ñandú', data: weekData([dept('a', 'Diseño Audiovisual', 0.9)]), history: [], generatedAt: 'x', generatedBy: 'José Pérez', source: 'MANUAL' });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await workbook.xlsx.writeBuffer());
    const area = back.getWorksheet('Diseño Audiovisual')!;
    const all = JSON.stringify(area.getSheetValues());
    expect(all).toContain('Diseño de campaña ñandú');
    expect(JSON.stringify(back.getWorksheet('Notas')!.getSheetValues())).toContain('José Pérez');
  });

  it('sheet names are valid for Excel: ≤31 chars, no []:*?/\\, unique', () => {
    const taken = new Set<string>(['resumen']);
    expect(sheetName('Ventas/Marketing [Lima]: Q4?', taken)).toBe('Ventas-Marketing -Lima-- Q4-');
    expect(sheetName('Un nombre de área muy, muy largo que no cabe', taken)).toHaveLength(31);
    expect(sheetName('Resumen', taken)).toBe('Resumen (2)');
    expect(sheetName('Finanzas', taken)).toBe('Finanzas');
    expect(sheetName('FINANZAS', taken)).toBe('FINANZAS (2)');
  });

  it('E2.1: estimates rows from tasks, KPIs, functions and history', () => {
    const big = dept('a', 'A', 0.5, { tasks: Array.from({ length: 60_000 }, () => dept('x', 'x', 1).tasks[0]!) });
    expect(estimateRows(weekData([big]), 12)).toBeGreaterThan(50_000);
    expect(estimateRows(weekData([dept('a', 'A', 0.5)]), 12)).toBeLessThan(200);
  });

  it('status: expired beats deleted; available otherwise', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const later = new Date('2026-11-01T00:00:00Z');
    expect(reportStatus({ deletedAt: null, purgedAt: null, expiresAt: later }, now)).toBe('AVAILABLE');
    expect(reportStatus({ deletedAt: now, purgedAt: null, expiresAt: later }, now)).toBe('DELETED');
    expect(reportStatus({ deletedAt: now, purgedAt: null, expiresAt: now }, now)).toBe('EXPIRED');
    expect(reportStatus({ deletedAt: null, purgedAt: now, expiresAt: later }, now)).toBe('EXPIRED');
  });
});
