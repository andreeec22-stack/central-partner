import { randomUUID } from 'node:crypto';
import type { Prisma, ReportSource, Week, WeeklyReport } from '@prisma/client';
import { AppError, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma, type Tx } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';
import { dateToDay } from '../../lib/week';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import { buildWeekData, type WeekData } from '../weeks/week-data';
import { buildWeeklyReport, estimateRows, MAX_REPORT_BYTES, MAX_REPORT_ROWS, type HistoryWeek } from './report-workbook';

// Weekly Excel reports (MVP Fase 2). Generated automatically when an ADMIN
// closes a week (weeks.service → closeWeek) or on demand; kept 30 days;
// downloaded through the API by ADMINs only (no long-lived public link to a
// confidential file). Error scenarios E2.1–E2.6 are listed in docs/ERROR_LOG.md.

export const REPORT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HISTORY_WEEKS = 12;

// Mutable for tests (E2.1 limits).
export const reportLimits = { maxRows: MAX_REPORT_ROWS, maxBytes: MAX_REPORT_BYTES };

type ReportRow = WeeklyReport & { week: Pick<Week, 'id' | 'weekNumber' | 'year' | 'mondayDate'>; generatedBy: { id: string; displayName: string } | null };
const include = {
  week: { select: { id: true, weekNumber: true, year: true, mondayDate: true } },
  generatedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.WeeklyReportInclude;

export function reportStatus(r: Pick<WeeklyReport, 'deletedAt' | 'expiresAt' | 'purgedAt'>, now = new Date()) {
  if (r.purgedAt || r.expiresAt <= now) return 'EXPIRED' as const;
  if (r.deletedAt) return 'DELETED' as const;
  return 'AVAILABLE' as const;
}

export function presentReport(r: ReportRow, now = new Date()) {
  return {
    id: r.id,
    week: { id: r.week.id, weekNumber: r.week.weekNumber, year: r.week.year, mondayDate: dateToDay(r.week.mondayDate) },
    source: r.source,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    rowCount: r.rowCount,
    sheetCount: r.sheetCount,
    generatedBy: r.generatedBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    deletedAt: r.deletedAt,
    status: reportStatus(r, now),
    // Authenticated download through the API (ADMIN only).
    downloadUrl: `/api/v1/export/${r.id}/download`,
  };
}

// The 12 weeks ending with the reported one: closed weeks from their frozen
// snapshots, the reported week from the data being written.
async function historyFor(db: Tx, workspaceId: string, data: WeekData): Promise<HistoryWeek[]> {
  const archives = await db.weeklyArchive.findMany({
    where: { workspaceId, weekStart: { lt: new Date(`${data.week.mondayDate}T00:00:00.000Z`) } },
    orderBy: { weekStart: 'desc' },
    take: HISTORY_WEEKS - 1,
    select: { data: true },
  });
  const toHistory = (d: WeekData): HistoryWeek => ({
    weekNumber: d.week.weekNumber,
    year: d.week.year,
    mondayDate: d.week.mondayDate,
    overall: d.overall.index,
    byDepartment: Object.fromEntries(d.departments.map((x) => [x.id, x.metrics.index])),
  });
  return [...archives.reverse().map((a) => toHistory(a.data as unknown as WeekData)), toHistory(data)];
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export interface GenerateParams {
  workspaceId: string;
  timeZone: string;
  weekId: string;
  source: ReportSource;
  actor: { id: string; displayName: string } | null;
  ipAddress?: string;
}

export async function generateWeeklyReport(p: GenerateParams): Promise<ReportRow> {
  const week = await prisma.week.findFirst({ where: { id: p.weekId, workspaceId: p.workspaceId } });
  if (!week) throw new AppError(404, 'WEEK_NOT_FOUND', 'Semana no encontrada');

  const created = await prisma.$transaction(
    async (tx) => {
      // E2.5: one generation per week at a time. The lock lives as long as this
      // transaction, so it is released even if generation fails (no Redis needed).
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`weekly-report:${week.id}`}, 0)) AS locked`;
      if (!lock?.locked) throw new AppError(409, 'EXPORT_IN_PROGRESS', 'Ya se está generando el reporte de esta semana; intenta en unos segundos');

      const archive = week.status === 'ARCHIVED' ? await tx.weeklyArchive.findUnique({ where: { weekId: week.id } }) : null;
      const data = archive ? (archive.data as unknown as WeekData) : await buildWeekData(tx, week, p.timeZone, null);

      // E2.1: refuse before building anything big.
      const estimated = estimateRows(data, HISTORY_WEEKS);
      if (estimated > reportLimits.maxRows) {
        logger.warn('weekly report refused: too many rows', { weekId: week.id, estimated });
        throw new AppError(413, 'FILE_TOO_LARGE', `La semana tiene demasiados datos para un Excel (${estimated} filas; máximo ${reportLimits.maxRows})`, { rows: estimated, maxRows: reportLimits.maxRows });
      }

      const branding = await tx.workspaceBranding.findUnique({ where: { workspaceId: p.workspaceId }, select: { workspaceName: true } });
      const generatedAt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: p.timeZone }).format(new Date());
      const { workbook, rowCount, sheetCount } = buildWeeklyReport({
        workspaceName: branding?.workspaceName ?? 'Central Partner',
        data,
        history: await historyFor(tx, p.workspaceId, data),
        generatedAt,
        generatedBy: p.actor?.displayName ?? null,
        source: p.source,
      });
      const buffer = new Uint8Array(await workbook.xlsx.writeBuffer());
      if (buffer.byteLength > reportLimits.maxBytes) {
        throw new AppError(413, 'FILE_TOO_LARGE', `El reporte supera ${Math.round(reportLimits.maxBytes / 1024 / 1024)} MB`, { bytes: buffer.byteLength });
      }

      const id = randomUUID();
      const filename = `Reporte_${slug(branding?.workspaceName ?? 'CentralPartner')}_Semana${week.weekNumber}_${week.year}.xlsx`;
      const storageKey = `reports/${p.workspaceId}/${week.id}/${id}.xlsx`;
      await getStorage().put(storageKey, buffer, XLSX_TYPE);
      const now = new Date();
      const report = await tx.weeklyReport.create({
        data: {
          id,
          workspaceId: p.workspaceId,
          weekId: week.id,
          source: p.source,
          filename,
          storageKey,
          sizeBytes: buffer.byteLength,
          rowCount,
          sheetCount,
          generatedById: p.actor?.id ?? null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + REPORT_RETENTION_DAYS * DAY_MS),
        },
        include,
      });
      await logActivity(
        {
          workspaceId: p.workspaceId,
          userId: p.actor?.id ?? null,
          action: ActivityAction.REPORT_GENERATED,
          entityType: 'WeeklyReport',
          entityId: id,
          metadata: { weekNumber: week.weekNumber, source: p.source, sizeBytes: buffer.byteLength, rows: rowCount },
          ipAddress: p.ipAddress,
        },
        tx,
      );
      return report;
    },
    { timeout: 120_000 },
  );
  return created;
}

// Never lets a report failure undo the week closing: logged and audited instead.
export async function generateOnClose(user: AuthUser, weekId: string, ipAddress?: string) {
  try {
    const report = await generateWeeklyReport({
      workspaceId: user.workspaceId,
      timeZone: user.workspaceTimezone,
      weekId,
      source: 'WEEK_CLOSED',
      actor: { id: user.id, displayName: user.displayName },
      ipAddress,
    });
    return presentReport(report);
  } catch (error) {
    logger.error('weekly report on close failed', { error, weekId });
    await logActivity({
      workspaceId: user.workspaceId,
      userId: user.id,
      action: ActivityAction.REPORT_GENERATION_FAILED,
      entityType: 'Week',
      entityId: weekId,
      metadata: { reason: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      ipAddress,
    }).catch(() => undefined);
    return null;
  }
}

// ─── ADMIN endpoints ────────────────────────────────────────────────────────

async function findReport(user: AuthUser, id: string): Promise<ReportRow> {
  const r = await prisma.weeklyReport.findFirst({ where: { id, workspaceId: user.workspaceId }, include });
  if (!r) throw notFound('Report');
  return r;
}

export async function listReports(user: AuthUser, q: { weekId?: string; includeDeleted: boolean }) {
  const rows = await prisma.weeklyReport.findMany({
    where: { workspaceId: user.workspaceId, ...(q.weekId ? { weekId: q.weekId } : {}), ...(q.includeDeleted ? {} : { deletedAt: null }) },
    include,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const now = new Date();
  return { data: rows.map((r) => presentReport(r, now)) };
}

export async function downloadReport(user: AuthUser, id: string, ipAddress?: string) {
  const r = await findReport(user, id);
  if (r.deletedAt) throw notFound('Report');
  if (reportStatus(r) === 'EXPIRED') throw new AppError(410, 'EXPORT_EXPIRED', 'El reporte venció (se guardan 30 días); genéralo de nuevo');
  const bytes = await getStorage().get(r.storageKey);
  if (!bytes) throw new AppError(410, 'EXPORT_EXPIRED', 'El archivo del reporte ya no está disponible; genéralo de nuevo');
  // Confidential document: every download is on the record.
  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.REPORT_DOWNLOADED,
    entityType: 'WeeklyReport',
    entityId: id,
    metadata: { weekNumber: r.week.weekNumber, filename: r.filename },
    ipAddress,
  });
  return { bytes, filename: r.filename };
}

export async function deleteReport(user: AuthUser, id: string, ipAddress?: string) {
  const r = await findReport(user, id);
  if (!r.deletedAt) {
    await prisma.weeklyReport.update({ where: { id }, data: { deletedAt: new Date(), deletedById: user.id } });
    await logActivity({ workspaceId: user.workspaceId, userId: user.id, action: ActivityAction.REPORT_DELETED, entityType: 'WeeklyReport', entityId: id, metadata: { weekNumber: r.week.weekNumber }, ipAddress });
  }
  return { report: presentReport(await findReport(user, id)) };
}

export async function restoreReport(user: AuthUser, id: string, ipAddress?: string) {
  const r = await findReport(user, id);
  if (reportStatus(r) === 'EXPIRED') throw new AppError(410, 'EXPORT_EXPIRED', 'El reporte ya venció y no se puede restaurar');
  if (r.deletedAt) {
    await prisma.weeklyReport.update({ where: { id }, data: { deletedAt: null, deletedById: null } });
    await logActivity({ workspaceId: user.workspaceId, userId: user.id, action: ActivityAction.REPORT_RESTORED, entityType: 'WeeklyReport', entityId: id, metadata: { weekNumber: r.week.weekNumber }, ipAddress });
  }
  return { report: presentReport(await findReport(user, id)) };
}

// ─── Retention (E2.6) ───────────────────────────────────────────────────────

// Removes the files of expired reports and stamps purgedAt; the rows stay so
// the audit trail keeps "who generated / downloaded what".
export async function purgeExpiredReports(now = new Date(), batch = 500) {
  const expired = await prisma.weeklyReport.findMany({
    where: { expiresAt: { lte: now }, purgedAt: null },
    select: { id: true, workspaceId: true, storageKey: true },
    take: batch,
  });
  const purged: string[] = [];
  for (const r of expired) {
    try {
      await getStorage().delete(r.storageKey);
      purged.push(r.id);
    } catch (error) {
      logger.error('report purge failed', { error, reportId: r.id });
    }
  }
  if (purged.length) {
    await prisma.weeklyReport.updateMany({ where: { id: { in: purged } }, data: { purgedAt: now } });
    const byWorkspace = new Map<string, number>();
    for (const r of expired.filter((x) => purged.includes(x.id))) byWorkspace.set(r.workspaceId, (byWorkspace.get(r.workspaceId) ?? 0) + 1);
    for (const [workspaceId, count] of byWorkspace) {
      await logActivity({ workspaceId, userId: null, action: ActivityAction.REPORTS_PURGED, entityType: 'WeeklyReport', metadata: { count, retentionDays: REPORT_RETENTION_DAYS } });
    }
    logger.info('expired reports purged', { count: purged.length });
  }
  return purged.length;
}

export function startReportCleanup(intervalMs = 60 * 60 * 1000) {
  const run = () => void purgeExpiredReports().catch((error) => logger.error('report cleanup crashed', { error }));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
