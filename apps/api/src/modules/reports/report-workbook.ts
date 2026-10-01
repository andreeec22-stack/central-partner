import ExcelJS from 'exceljs';
import type { WeekData, WeekDepartment } from '../weeks/week-data';

// The weekly report as a workbook (pure: data in, workbook out).
//
//   Resumen        week, company index, top 3 / bottom 3 areas, every area
//   <one per area> its index, ①②③, 12-week history, top tasks, critical
//                  pending tasks, KPIs and functions
//   Histórico      last 12 weeks: one column per area + company
//   Notas          when, by whom, source and the validations that ran
//
// Index and ①②③ are fractions 0–1 shown as %. xlsx stores text as UTF-8
// XML, so accents and ñ survive as-is (no BOM needed — that is a CSV concern).

// E2.1: past this, the report is refused before building (413 FILE_TOO_LARGE).
export const MAX_REPORT_ROWS = 50_000;
// E2.1: the written file must stay under this.
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

export interface HistoryWeek {
  weekNumber: number;
  year: number;
  mondayDate: string;
  overall: number | null;
  byDepartment: Record<string, number | null>;
}

export interface ReportInput {
  workspaceName: string;
  data: WeekData;
  // Oldest → newest, ending with the reported week.
  history: HistoryWeek[];
  generatedAt: string;
  generatedBy: string | null;
  source: 'WEEK_CLOSED' | 'MANUAL';
}

const SEMAPHORE_ES: Record<string, string> = { GREEN: 'Verde · en meta', YELLOW: 'Amarillo · en riesgo', RED: 'Rojo · crítico', GRAY: 'Sin datos' };
const FULFILLED_ES: Record<string, string> = { YES: 'Sí', PARTIAL: 'Parcial', NO: 'No', NOT_APPLICABLE: 'No aplica' };
const COLORS = {
  header: 'FF4B5563',
  title: 'FF1F2A44',
  muted: 'FF6B7280',
  semaphore: { GREEN: 'FFDCFCE7', YELLOW: 'FFFEF9C3', RED: 'FFFEE2E2', GRAY: 'FFF1F5F9' } as Record<string, string>,
};
const PCT = '0.0%';
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const semaphoreText = (s: string | null | undefined) => (s ? (SEMAPHORE_ES[s] ?? s) : 'Sin datos');

// Excel sheet names: ≤ 31 chars, none of []:*?/\, unique (case-insensitive), not "History".
export function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, '-').trim().slice(0, 31) || 'Área';
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()) || candidate.toLowerCase() === 'history'; n++) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// Rows the report will write, to refuse oversized data before building (E2.1).
export function estimateRows(data: WeekData, historyWeeks: number): number {
  const perArea = data.departments.reduce((sum, d) => sum + d.tasks.length + d.kpis.length + d.functions.length + historyWeeks + 20, 0);
  return perArea + historyWeeks + data.departments.length + 40;
}

interface Col {
  header: string;
  width?: number;
  pct?: boolean;
  numeric?: boolean;
}

class SheetWriter {
  rows = 0;
  constructor(readonly sheet: ExcelJS.Worksheet) {}

  title(text: string, subtitle?: string) {
    this.sheet.addRow([text]).font = { bold: true, size: 14, color: { argb: COLORS.title } };
    if (subtitle) this.sheet.addRow([subtitle]).font = { italic: true, color: { argb: COLORS.muted } };
    this.sheet.addRow([]);
    this.rows += subtitle ? 3 : 2;
  }

  section(text: string) {
    this.sheet.addRow([]);
    this.sheet.addRow([text]).font = { bold: true, size: 12, color: { argb: COLORS.title } };
    this.rows += 2;
  }

  // Label/value pairs; values that are fractions get a % format.
  pairs(items: [string, string | number | null, ('pct' | 'semaphore')?][]) {
    for (const [label, value, kind] of items) {
      const row = this.sheet.addRow([label, value ?? '—']);
      row.getCell(1).font = { bold: true };
      if (kind === 'pct' && typeof value === 'number') row.getCell(2).numFmt = PCT;
      if (kind === 'semaphore' && typeof value === 'string') {
        const key = Object.keys(SEMAPHORE_ES).find((k) => SEMAPHORE_ES[k] === value);
        if (key) row.getCell(2).fill = fill(COLORS.semaphore[key]!);
      }
      this.rows++;
    }
  }

  table(columns: Col[], data: (string | number | null)[][], semaphoreCol?: number, semaphores?: (string | null)[]) {
    const header = this.sheet.addRow(columns.map((c) => c.header));
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = fill(COLORS.header);
    });
    this.rows++;
    if (!data.length) {
      this.sheet.addRow(['(sin datos)']).font = { italic: true, color: { argb: COLORS.muted } };
      this.rows++;
      return;
    }
    data.forEach((values, i) => {
      const row = this.sheet.addRow(values.map((v) => v ?? '—'));
      columns.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        if (c.pct && typeof values[j] === 'number') cell.numFmt = PCT;
        if (c.numeric || c.pct) cell.alignment = { horizontal: 'right' };
      });
      const s = semaphores?.[i];
      if (semaphoreCol !== undefined && s && COLORS.semaphore[s]) row.getCell(semaphoreCol + 1).fill = fill(COLORS.semaphore[s]);
      this.rows++;
    });
  }

  widths(widths: number[]) {
    widths.forEach((w, i) => (this.sheet.getColumn(i + 1).width = w));
  }
}

const weekLabel = (h: { weekNumber: number; mondayDate: string }) => `Sem. ${h.weekNumber} (${h.mondayDate})`;

function areaSheet(w: SheetWriter, d: WeekDepartment, history: HistoryWeek[], subtitle: string) {
  const m = d.metrics;
  w.title(d.name, subtitle);
  w.pairs([
    ['Jefe', d.head?.displayName ?? 'Sin asignar'],
    ['Índice', m.index, 'pct'],
    ['Semáforo', semaphoreText(m.semaphore), 'semaphore'],
    ['① Avance de tareas', m.taskProgress, 'pct'],
    ['② Cumplimiento de KPIs', m.kpiCompliance, 'pct'],
    ['③ Cumplimiento de funciones', m.functionCompliance, 'pct'],
    ['Tareas', m.tasks.total],
    ['Completadas', m.tasks.done],
    ['% Completadas', m.tasks.total ? m.tasks.done / m.tasks.total : null, 'pct'],
    ['Atrasadas', m.tasks.overdue],
  ]);

  w.section('Índice de las últimas 12 semanas');
  w.table(
    [{ header: 'Semana' }, { header: 'Índice', pct: true }],
    history.map((h) => [weekLabel(h), h.byDepartment[d.id] ?? null]),
  );

  const byProgress = [...d.tasks].sort((a, b) => b.progress - a.progress);
  w.section('Tareas con más avance');
  w.table(
    [{ header: 'Tarea' }, { header: 'Responsable' }, { header: '% Avance', pct: true }],
    byProgress.slice(0, 5).map((t) => [t.title, t.assignedTo?.displayName ?? 'Sin asignar', t.progress / 100]),
  );

  const critical = d.tasks.filter((t) => t.progress < 100 && (t.semaphore === 'RED' || t.status === 'BLOCKED'));
  w.section('Tareas pendientes críticas (vencidas o bloqueadas)');
  w.table(
    [{ header: 'Tarea' }, { header: 'Día' }, { header: 'Responsable' }, { header: '% Avance', pct: true }, { header: 'Bloqueo' }],
    critical.map((t) => [t.title, t.day, t.assignedTo?.displayName ?? 'Sin asignar', t.progress / 100, t.blockReason]),
  );

  w.section('KPIs');
  w.table(
    [{ header: 'KPI' }, { header: 'Meta', numeric: true }, { header: 'Real', numeric: true }, { header: 'Unidad' }, { header: '% Cumplimiento', pct: true }, { header: 'Semáforo' }],
    d.kpis.map((k) => [k.title, k.target, k.actual, k.unit, k.completion, semaphoreText(k.semaphore)]),
    5,
    d.kpis.map((k) => k.semaphore),
  );

  w.section('Funciones');
  w.table(
    [{ header: 'Función' }, { header: '¿Cumplió?' }, { header: 'Observación' }],
    d.functions.map((f) => [f.title, f.fulfilled ? (FULFILLED_ES[f.fulfilled] ?? f.fulfilled) : 'Sin marcar', f.observation]),
  );
  w.widths([44, 26, 16, 14, 16, 22]);
  w.sheet.views = [{ state: 'frozen', ySplit: 2 }];
}

export function buildWeeklyReport(input: ReportInput) {
  const { data, history } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Central Partner';
  wb.created = new Date();
  const subtitle = `Semana ${data.week.weekNumber} · ${data.week.mondayDate} al ${data.week.saturdayDate} · ${input.workspaceName}`;
  const taken = new Set<string>(['resumen', 'histórico', 'notas']);
  let rows = 0;

  // ── Resumen
  const summary = new SheetWriter(wb.addWorksheet('Resumen'));
  summary.title(`Reporte semanal · ${input.workspaceName}`, subtitle);
  summary.pairs([
    ['Semana', `${data.week.weekNumber} (${data.week.year})`],
    ['Periodo', `${data.week.mondayDate} al ${data.week.saturdayDate}`],
    ['Índice total', data.overall.index, 'pct'],
    ['Semáforo', semaphoreText(data.overall.semaphore), 'semaphore'],
    ['Áreas en meta / riesgo / críticas / sin datos', `${data.overall.areasBySemaphore.GREEN} / ${data.overall.areasBySemaphore.YELLOW} / ${data.overall.areasBySemaphore.RED} / ${data.overall.areasBySemaphore.NONE}`],
    ['Tareas (completadas de total)', `${data.overall.tasks.done} de ${data.overall.tasks.total}`],
  ]);
  const ranked = data.departments.filter((d) => d.metrics.index !== null).sort((a, b) => b.metrics.index! - a.metrics.index!);
  const rankCols: Col[] = [{ header: 'Área' }, { header: 'Índice', pct: true }, { header: 'Semáforo' }];
  const rankRow = (d: WeekDepartment) => [d.name, d.metrics.index, semaphoreText(d.metrics.semaphore)];
  summary.section('Top 3 áreas');
  summary.table(rankCols, ranked.slice(0, 3).map(rankRow), 2, ranked.slice(0, 3).map((d) => d.metrics.semaphore));
  // Worst first, never repeating an area already in the top 3.
  const bottom = ranked.slice(Math.max(3, ranked.length - 3)).reverse();
  summary.section('Bottom 3 áreas');
  summary.table(rankCols, bottom.map(rankRow), 2, bottom.map((d) => d.metrics.semaphore));
  summary.section('Todas las áreas');
  summary.table(
    [{ header: 'Área' }, { header: 'Jefe' }, { header: 'Tareas', numeric: true }, { header: '① Avance', pct: true }, { header: '② KPIs', pct: true }, { header: '③ Funciones', pct: true }, { header: 'Índice', pct: true }, { header: 'Semáforo' }],
    data.departments.map((d) => [d.name, d.head?.displayName ?? '—', d.metrics.tasks.total, d.metrics.taskProgress, d.metrics.kpiCompliance, d.metrics.functionCompliance, d.metrics.index, semaphoreText(d.metrics.semaphore)]),
    7,
    data.departments.map((d) => d.metrics.semaphore),
  );
  summary.section('Tendencia semanal (índice total)');
  summary.table([{ header: 'Semana' }, { header: 'Índice', pct: true }], history.map((h) => [weekLabel(h), h.overall]));
  summary.widths([44, 26, 12, 12, 12, 12, 12, 22]);
  rows += summary.rows;

  // ── One sheet per area
  for (const d of data.departments) {
    const w = new SheetWriter(wb.addWorksheet(sheetName(d.name, taken)));
    areaSheet(w, d, history, subtitle);
    rows += w.rows;
  }

  // ── Histórico
  const hist = new SheetWriter(wb.addWorksheet('Histórico'));
  hist.title('Índice por área · últimas 12 semanas', subtitle);
  hist.table(
    [{ header: 'Semana' }, ...data.departments.map((d) => ({ header: d.name, pct: true })), { header: 'Empresa', pct: true }],
    history.map((h) => [weekLabel(h), ...data.departments.map((d) => h.byDepartment[d.id] ?? null), h.overall]),
  );
  hist.widths([24, ...data.departments.map(() => 14), 12]);
  hist.sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
  rows += hist.rows;

  // ── Notas
  const notes = new SheetWriter(wb.addWorksheet('Notas'));
  notes.title('Notas del reporte');
  notes.pairs([
    ['Generado', input.generatedAt],
    ['Generado por', input.generatedBy ?? 'Cierre automático de la semana'],
    ['Origen', input.source === 'WEEK_CLOSED' ? 'Al cerrar la semana' : 'Generación manual'],
    ['Datos', data.week.status === 'ARCHIVED' ? 'Snapshot congelado al cierre' : 'Semana abierta: datos en vivo al momento de generar'],
    ['Validación: filas', `${rows + 12} de un máximo de ${MAX_REPORT_ROWS.toLocaleString('es')}`],
    ['Validación: tamaño', `Máximo ${MAX_REPORT_BYTES / 1024 / 1024} MB (verificado al escribir el archivo)`],
    ['Validación: hojas', `${wb.worksheets.length} (resumen, ${data.departments.length} áreas, histórico, notas)`],
  ]);
  notes.widths([28, 70]);
  rows += notes.rows;

  return { workbook: wb, rowCount: rows, sheetCount: wb.worksheets.length };
}
