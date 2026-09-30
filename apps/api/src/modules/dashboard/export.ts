import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import type { WeekData } from '../weeks/week-data';
import { assertVisibleArea, scopedWeekData } from './weekly-dashboard.service';

// The dashboard as an Excel workbook: a branded summary sheet (one row per
// area + company total) and the detail sheets behind it (tasks, KPIs,
// functions). Honors the dashboard's filters: week and area.
// TODO: charts as images — exceljs can embed images but can't draw charts, and
// rendering them server-side would need a headless browser; not worth it yet.

const SEMAPHORE_ES: Record<string, string> = { GREEN: 'Verde', YELLOW: 'Amarillo', RED: 'Rojo', GRAY: 'Gris' };
const FULFILLED_ES: Record<string, string> = { YES: 'Sí', PARTIAL: 'Parcial', NO: 'No', NOT_APPLICABLE: 'No aplica' };
const TYPE_ES: Record<string, string> = { RESULT: 'Resultado', COMPLIANCE: 'Cumplimiento', PROGRESS: 'Avance' };
const TREND_ES: Record<string, string> = { UP: '↑', DOWN: '↓', STABLE: '=' };
const FREQ_ES: Record<string, string> = { DAILY: 'Diaria', WEEKLY: 'Semanal', MONTHLY: 'Mensual', WHEN_OCCURS: 'Cuando ocurra', WHEN_CHANGES: 'Cuando cambie' };

const COLORS = {
  headerFill: 'FF4B5563', // gray-600, white bold text
  stripe: 'FFF3F4F6', // alternate rows
  title: 'FF1F2A44',
  muted: 'FF6B7280',
  semaphore: { GREEN: 'FFDCFCE7', YELLOW: 'FFFEF9C3', RED: 'FFFEE2E2', GRAY: 'FFF1F5F9' } as Record<string, string>,
};

interface Column {
  header: string;
  key: string;
  numFmt?: string;
  numeric?: boolean;
}

const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// Title block + header row + striped data rows, auto-width, frozen header.
function writeTable(
  sheet: ExcelJS.Worksheet,
  title: string,
  subtitle: string,
  columns: Column[],
  rows: Record<string, unknown>[],
  semaphoreKey?: { column: string; value: (row: Record<string, unknown>) => string | null },
) {
  sheet.addRow([title]).font = { bold: true, size: 14, color: { argb: COLORS.title } };
  sheet.addRow([subtitle]).font = { italic: true, color: { argb: COLORS.muted } };
  sheet.addRow([]);
  const headerRowNumber = 4;
  const header = sheet.addRow(columns.map((c) => c.header));
  header.eachCell((cell, col) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill(COLORS.headerFill);
    cell.alignment = { vertical: 'middle', horizontal: columns[col - 1]!.numeric ? 'right' : 'left' };
  });

  rows.forEach((data, i) => {
    const row = sheet.addRow(columns.map((c) => data[c.key] ?? null));
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const column = columns[col - 1]!;
      if (i % 2 === 1) cell.fill = fill(COLORS.stripe);
      if (column.numFmt) cell.numFmt = column.numFmt;
      cell.alignment = { horizontal: column.numeric ? 'right' : 'left' };
    });
    if (semaphoreKey) {
      const value = semaphoreKey.value(data);
      const index = columns.findIndex((c) => c.key === semaphoreKey.column) + 1;
      if (value && COLORS.semaphore[value]) row.getCell(index).fill = fill(COLORS.semaphore[value]!);
    }
    if (data.__bold) row.font = { bold: true };
  });

  // Width from the longest value in each column (title rows excluded).
  columns.forEach((c, i) => {
    const longest = Math.max(
      c.header.length,
      ...rows.map((r) => {
        const v = r[c.key];
        return v === null || v === undefined ? 1 : typeof v === 'number' ? 8 : String(v).length;
      }),
    );
    sheet.getColumn(i + 1).width = Math.min(Math.max(longest + 2, 8), 60);
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  if (rows.length) sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: columns.length } };
}

const semaphoreText = (v: string | null) => (v ? SEMAPHORE_ES[v] ?? v : '—');

function buildWorkbook(data: WeekData, workspaceName: string, areaName: string | null, generatedAt: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Central Partner';
  wb.created = new Date();
  const scope = areaName ? `Área: ${areaName}` : 'Todas las áreas';
  const subtitle = `Semana ${data.week.weekNumber} (${data.week.mondayDate} al ${data.week.saturdayDate}) · ${scope} · Generado: ${generatedAt}`;
  const title = `${workspaceName} - Dashboard`;

  const summaryRows: Record<string, unknown>[] = data.departments.map((d) => {
    const m = d.metrics;
    return {
      name: d.name,
      head: d.head?.displayName ?? '—',
      total: m.tasks.total,
      donePct: m.tasks.total ? m.tasks.done / m.tasks.total : null,
      overdue: m.tasks.overdue,
      taskProgress: m.taskProgress,
      kpiCompliance: m.kpiCompliance,
      functionCompliance: m.functionCompliance,
      index: m.index,
      semaphore: semaphoreText(m.semaphore),
      __semaphore: m.semaphore,
    };
  });
  if (!areaName) {
    const o = data.overall;
    summaryRows.push({
      name: 'TOTAL EMPRESA',
      head: '',
      total: o.tasks.total,
      donePct: o.tasks.total ? o.tasks.done / o.tasks.total : null,
      overdue: o.tasks.overdue,
      taskProgress: o.taskProgress,
      kpiCompliance: o.kpiCompliance,
      functionCompliance: o.functionCompliance,
      index: o.index,
      semaphore: semaphoreText(o.semaphore),
      __semaphore: o.semaphore,
      __bold: true,
    });
  }
  const pct = '0.0%';
  writeTable(
    wb.addWorksheet('Resumen'),
    title,
    subtitle,
    [
      { header: 'Área', key: 'name' },
      { header: 'Jefe', key: 'head' },
      { header: 'Total Tareas', key: 'total', numeric: true },
      { header: '% Completadas', key: 'donePct', numeric: true, numFmt: pct },
      { header: 'Atrasadas', key: 'overdue', numeric: true },
      { header: '① Avance', key: 'taskProgress', numeric: true, numFmt: pct },
      { header: '② KPIs', key: 'kpiCompliance', numeric: true, numFmt: pct },
      { header: '③ Funciones', key: 'functionCompliance', numeric: true, numFmt: pct },
      { header: 'Índice', key: 'index', numeric: true, numFmt: pct },
      { header: 'Semáforo', key: 'semaphore' },
    ],
    summaryRows,
    { column: 'semaphore', value: (r) => r.__semaphore as string | null },
  );

  writeTable(
    wb.addWorksheet('Tareas'),
    title,
    subtitle,
    [
      { header: 'Área', key: 'area' },
      { header: 'Día', key: 'day' },
      { header: 'Tarea', key: 'title' },
      { header: 'Responsable', key: 'assignee' },
      { header: '% Avance', key: 'progress', numeric: true, numFmt: '0%' },
      { header: 'Estado', key: 'state' },
      { header: 'Viene de', key: 'carried' },
      { header: 'Observación', key: 'observation' },
    ],
    data.departments.flatMap((d) =>
      d.tasks.map((t) => ({
        area: d.name,
        day: t.day ?? '',
        title: t.title,
        assignee: t.assignedTo?.displayName ?? 'Sin asignar',
        progress: t.progress / 100,
        state: semaphoreText(t.semaphore),
        __semaphore: t.semaphore,
        carried: t.carriedFrom ? `Sem. ${t.carriedFrom.weekNumber}` : '',
        observation: t.observation ?? '',
      })),
    ),
    { column: 'state', value: (r) => r.__semaphore as string },
  );

  writeTable(
    wb.addWorksheet('KPIs'),
    title,
    subtitle,
    [
      { header: 'Área', key: 'area' },
      { header: 'KPI', key: 'title' },
      { header: 'Tipo', key: 'type' },
      { header: 'Meta', key: 'target', numeric: true },
      { header: 'Real', key: 'actual', numeric: true },
      { header: 'Unidad', key: 'unit' },
      { header: 'Menos es mejor', key: 'lesser' },
      { header: '% Cumplimiento', key: 'completion', numeric: true, numFmt: pct },
      { header: 'Semáforo', key: 'semaphore' },
      { header: 'Tendencia', key: 'trend' },
    ],
    data.departments.flatMap((d) =>
      d.kpis.map((k) => ({
        area: d.name,
        title: k.title,
        type: TYPE_ES[k.type] ?? k.type,
        target: k.target,
        actual: k.actual,
        unit: k.unit ?? '',
        lesser: k.lesserIsBetter ? 'Sí' : 'No',
        completion: k.completion,
        semaphore: semaphoreText(k.semaphore),
        __semaphore: k.semaphore,
        trend: k.trend ? TREND_ES[k.trend] : '',
      })),
    ),
    { column: 'semaphore', value: (r) => r.__semaphore as string | null },
  );

  writeTable(
    wb.addWorksheet('Funciones'),
    title,
    subtitle,
    [
      { header: 'Área', key: 'area' },
      { header: 'Función', key: 'title' },
      { header: 'Frecuencia', key: 'frequency' },
      { header: '¿Cumplió?', key: 'fulfilled' },
      { header: 'Observación', key: 'observation' },
    ],
    data.departments.flatMap((d) =>
      d.functions.map((f) => ({
        area: d.name,
        title: f.title,
        frequency: FREQ_ES[f.frequency] ?? f.frequency,
        fulfilled: f.fulfilled ? FULFILLED_ES[f.fulfilled] : '—',
        observation: f.observation ?? '',
      })),
    ),
  );
  return wb;
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 40);

export async function exportDashboardExcel(user: AuthUser, weekRef: string | undefined, areaId?: string) {
  await assertVisibleArea(user, areaId);
  const { data } = await scopedWeekData(user, weekRef, areaId);
  const branding = await prisma.workspaceBranding.findUnique({ where: { workspaceId: user.workspaceId }, select: { workspaceName: true } });
  const areaName = areaId ? (data.departments[0]?.name ?? null) : null;
  const generatedAt = new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: user.workspaceTimezone,
  }).format(new Date());

  const wb = buildWorkbook(data, branding?.workspaceName ?? 'Central Partner', areaName, generatedAt);
  const buffer = new Uint8Array(await wb.xlsx.writeBuffer());
  const filename = `DashboardCentralPartner_Week${data.week.weekNumber}${areaName ? `_${slug(areaName)}` : ''}.xlsx`;
  return { buffer, filename };
}
