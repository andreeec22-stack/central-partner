import { TZDate } from '@date-fns/tz';
import type { Prisma, Week } from '@prisma/client';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { departmentScope } from '../../lib/permissions';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { addDays, dateToDay, dayToDate, isLastSaturdayOfMonth, isoWeek, localDay, mondayOf, mondayOfDay, saturdayOf } from '../../lib/week';
import type { AuthUser } from '../../types';
import { generateOnClose } from '../reports/reports.service';
import { takeKpiSnapshot } from './kpi-snapshot';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { notifySafely } from '../notifications/notify.service';
import { buildWeekData, type WeekData } from './week-data';

// The weekly cycle (Monday–Saturday, workspace timezone):
//   Monday   the week exists — created by the scheduler or on first use —
//            with last week's KPIs and functions copied as its starting set
//   daily    assignees update % (①)
//   Saturday area heads record KPI results (②) and mark functions (③)
//   close    an ADMIN archives it: completeness check, frozen snapshot,
//            unfinished tasks move to the next week ("Viene de Sem. NN")

export const MONTHLY_REVIEW_TITLE = '🏁 Exponer resultados del mes';

export function presentWeek(w: Week) {
  const monday = dateToDay(w.mondayDate);
  return {
    id: w.id,
    mondayDate: monday,
    saturdayDate: saturdayOf(monday),
    weekNumber: w.weekNumber,
    year: w.year,
    status: w.status,
    archivedAt: w.archivedAt,
    createdAt: w.createdAt,
  };
}

export async function workspaceTimezone(workspaceId: string) {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
  return ws.timezone;
}

// Copies the latest earlier week's KPIs and functions (definitions only,
// results cleared) and, on the month's last week, adds the monthly review task.
async function seedWeek(tx: Tx, week: Week) {
  const monday = dateToDay(week.mondayDate);
  const departments = await tx.department.findMany({
    where: { workspaceId: week.workspaceId, deletedAt: null },
    select: { id: true, headId: true },
  });
  const activeIds = departments.map((d) => d.id);
  const previous = await tx.week.findFirst({
    where: { workspaceId: week.workspaceId, mondayDate: { lt: week.mondayDate } },
    orderBy: { mondayDate: 'desc' },
    select: { id: true },
  });
  if (previous) {
    const [kpis, functions] = await Promise.all([
      tx.kpi.findMany({ where: { weekId: previous.id, departmentId: { in: activeIds } } }),
      tx.departmentFunction.findMany({ where: { weekId: previous.id, departmentId: { in: activeIds } } }),
    ]);
    if (kpis.length) {
      await tx.kpi.createMany({
        data: kpis.map((k) => ({
          workspaceId: k.workspaceId,
          weekId: week.id,
          departmentId: k.departmentId,
          title: k.title,
          description: k.description,
          type: k.type,
          unit: k.unit,
          target: k.target,
          lesserIsBetter: k.lesserIsBetter,
          order: k.order,
          createdById: k.createdById,
        })),
      });
    }
    if (functions.length) {
      await tx.departmentFunction.createMany({
        data: functions.map((f) => ({
          workspaceId: f.workspaceId,
          weekId: week.id,
          departmentId: f.departmentId,
          title: f.title,
          description: f.description,
          frequency: f.frequency,
          order: f.order,
          createdById: f.createdById,
        })),
      });
    }
  }

  const saturday = saturdayOf(monday);
  if (!isLastSaturdayOfMonth(saturday)) return;
  // System tasks still need a creator: the workspace's director.
  const director = await tx.user.findFirst({
    where: { workspaceId: week.workspaceId, role: 'ADMIN', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!director) return;
  const heads = await tx.user.findMany({
    where: { id: { in: departments.map((d) => d.headId).filter((id): id is string => !!id) }, deletedAt: null },
    select: { id: true, role: true, departmentId: true },
  });
  const validHead = (d: (typeof departments)[number]) =>
    heads.find((h) => h.id === d.headId && h.role !== 'VIEWER' && (h.role === 'ADMIN' || h.departmentId === d.id))?.id ?? null;
  await tx.task.createMany({
    data: departments.map((d) => ({
      workspaceId: week.workspaceId,
      departmentId: d.id,
      weekId: week.id,
      assignedToId: validHead(d),
      createdById: director.id,
      title: MONTHLY_REVIEW_TITLE,
      description:
        'Presentar en la reunión del sábado:\n• KPIs vs metas del mes\n• Logros principales\n• Problemas y riesgos\n• Plan para el siguiente mes',
      priority: 'HIGH',
      // Noon UTC stays on the same calendar day for any American or European timezone.
      dueDate: new Date(`${saturday}T12:00:00.000Z`),
      sourceType: 'SYSTEM',
      collaborationParticipantIds: [],
    })),
  });
}

// Idempotent and safe under concurrency (scheduler on several instances,
// first request of the day): exactly one Week row per workspace and Monday.
export async function ensureWeek(workspaceId: string, monday: string, createdById: string | null = null) {
  if (mondayOfDay(monday) !== monday) throw new Error(`not a Monday: ${monday}`);
  const key = { workspaceId_mondayDate: { workspaceId, mondayDate: dayToDate(monday) } };
  const existing = await prisma.week.findUnique({ where: key });
  if (existing) return { week: existing, created: false };

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`week:${workspaceId}:${monday}`}))`;
    const raced = await tx.week.findUnique({ where: key });
    if (raced) return { week: raced, created: false };
    const week = await tx.week.create({ data: { workspaceId, mondayDate: dayToDate(monday), ...isoWeek(monday), createdById } });
    await seedWeek(tx, week);
    await logActivity(
      { workspaceId, userId: createdById, action: ActivityAction.WEEK_CREATED, entityType: 'Week', entityId: week.id, metadata: { mondayDate: monday } },
      tx,
    );
    return { week, created: true };
  });

  if (result.created) {
    emitTo([rooms.workspace(workspaceId)], 'week:created', { week: presentWeek(result.week) });
    const heads = await prisma.user.findMany({ where: { workspaceId, role: 'JEFE_AREA', deletedAt: null }, select: { id: true } });
    await notifySafely({
      workspaceId,
      recipientIds: heads.map((h) => h.id),
      type: 'WEEK_STARTED',
      actor: null,
      title: `Tu semana ${result.week.weekNumber} está lista`,
      body: `Semana del ${monday} al ${saturdayOf(monday)}: revisa tus tareas, KPIs y funciones.`,
    });
  }
  return result;
}

export async function currentWeek(workspaceId: string, timeZone: string, now = new Date()) {
  return (await ensureWeek(workspaceId, mondayOf(now, timeZone))).week;
}

// The week a task belongs to, from its day (undated → the current week).
// Tasks can't be placed in a week that is already closed.
export async function weekForTask(workspaceId: string, timeZone: string, dueDate: Date | null, actorId: string | null) {
  const monday = mondayOf(dueDate ?? new Date(), timeZone);
  const { week } = await ensureWeek(workspaceId, monday, actorId);
  if (week.status === 'ARCHIVED') {
    throw validationError(`La semana ${week.weekNumber} ya está cerrada; elige una fecha de una semana abierta`, [
      { field: 'dueDate', message: 'week archived' },
    ]);
  }
  return week;
}

export function weekClosedError() {
  return new AppError(409, 'WEEK_ARCHIVED', 'Esta semana ya fue cerrada: solo se puede consultar');
}

// Write guard for anything that belongs to a week.
export async function assertWeekOpen(db: Tx, weekId: string | null) {
  if (!weekId) return;
  const week = await db.week.findUnique({ where: { id: weekId }, select: { status: true } });
  if (week?.status === 'ARCHIVED') throw weekClosedError();
}

export async function findWeek(user: AuthUser, id: string) {
  const week = await prisma.week.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (!week) throw notFound('Week');
  return week;
}

// "current" or a week id.
export async function resolveWeek(user: AuthUser, ref: string | undefined) {
  if (!ref || ref === 'current') return currentWeek(user.workspaceId, user.workspaceTimezone);
  return findWeek(user, ref);
}

// Closed weeks, newest first, with the numbers they closed at.
export async function listArchivedWeeks(user: AuthUser, q: { page: number; limit: number }) {
  const where = { workspaceId: user.workspaceId, status: 'ARCHIVED' as const };
  const [weeks, total] = await Promise.all([
    prisma.week.findMany({ where, orderBy: { mondayDate: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { archive: { select: { data: true } } } }),
    prisma.week.count({ where }),
  ]);
  const closers = await prisma.user.findMany({
    where: { id: { in: weeks.map((w) => w.archivedById).filter((id): id is string => !!id) } },
    select: { id: true, displayName: true },
  });
  return {
    data: weeks.map((w) => {
      const overall = (w.archive?.data as unknown as WeekData | undefined)?.overall;
      return {
        ...presentWeek(w),
        archivedBy: closers.find((u) => u.id === w.archivedById) ?? null,
        index: overall?.index ?? null,
        semaphore: overall?.semaphore ?? null,
        tasks: overall?.tasks ?? null,
      };
    }),
    total,
    page: q.page,
    limit: q.limit,
  };
}

export async function listWeeks(user: AuthUser, limit: number) {
  const current = await currentWeek(user.workspaceId, user.workspaceTimezone);
  const weeks = await prisma.week.findMany({
    where: { workspaceId: user.workspaceId },
    orderBy: { mondayDate: 'desc' },
    take: limit,
  });
  return { current: presentWeek(current), data: weeks.map(presentWeek) };
}

// ─── Week data (live, or the archived snapshot) ─────────────────────────────

async function visibleDepartmentIds(user: AuthUser): Promise<string[] | null> {
  const scope = await departmentScope(user);
  return scope.all ? null : scope.departmentIds;
}

// Archived weeks read from their snapshot, filtered to what the caller may see.
export async function weekData(user: AuthUser, week: Week): Promise<WeekData> {
  const visible = await visibleDepartmentIds(user);
  if (week.status === 'ARCHIVED') {
    const archive = await prisma.weeklyArchive.findUnique({ where: { weekId: week.id } });
    if (archive) {
      const data = archive.data as unknown as WeekData;
      return visible ? { ...data, departments: data.departments.filter((d) => visible.includes(d.id)) } : data;
    }
  }
  return buildWeekData(prisma, week, user.workspaceTimezone, visible);
}

// ─── Closing ────────────────────────────────────────────────────────────────

export interface ClosureIssue {
  departmentId: string;
  departmentName: string;
  tasksWithoutProgress: number;
  kpisMissing: number;
  functionsUnmarked: number;
  noKpis: boolean;
  noFunctions: boolean;
}

// What's still unfilled, per area: tasks already due still at 0%, KPIs
// without a real value, functions not marked, areas with nothing defined.
// The weekly closing happens on Saturday from 10:00 (workspace time), after
// the KPI and function results are in. Earlier weeks can be closed any time.
export const CLOSING_HOUR = 10;

export function closableAt(week: Week, timeZone: string): Date {
  const [y, m, d] = saturdayOf(dateToDay(week.mondayDate)).split('-').map(Number);
  return new Date(new TZDate(y!, m! - 1, d!, CLOSING_HOUR, 0, 0, timeZone).getTime());
}

export async function closureReport(user: AuthUser, week: Week, now = new Date()) {
  const data = await buildWeekData(prisma, week, user.workspaceTimezone, null, now);
  const today = localDay(now, user.workspaceTimezone);
  const departments: (ClosureIssue & { complete: boolean })[] = data.departments.map((d) => {
    const issue: ClosureIssue = {
      departmentId: d.id,
      departmentName: d.name,
      tasksWithoutProgress: d.tasks.filter((t) => t.progress === 0 && t.day !== null && t.day <= today).length,
      kpisMissing: d.kpis.filter((k) => k.actual === null).length,
      functionsUnmarked: d.functions.filter((f) => f.fulfilled === null).length,
      noKpis: d.kpis.length === 0,
      noFunctions: d.functions.length === 0,
    };
    const complete = !issue.tasksWithoutProgress && !issue.kpisMissing && !issue.functionsUnmarked && !issue.noKpis && !issue.noFunctions;
    return { ...issue, complete };
  });
  return {
    week: presentWeek(week),
    departments,
    incompleteCount: departments.filter((d) => !d.complete).length,
    closableAt: closableAt(week, user.workspaceTimezone),
    canClose: week.status === 'ACTIVE' && now >= closableAt(week, user.workspaceTimezone),
  };
}

export async function closeWeek(user: AuthUser, weekId: string, force: boolean, ctx: ClientContext) {
  const week = await findWeek(user, weekId);
  if (week.status === 'ARCHIVED') throw weekClosedError();
  const opensAt = closableAt(week, user.workspaceTimezone);
  if (new Date() < opensAt) {
    const when = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: user.workspaceTimezone }).format(opensAt);
    throw new AppError(409, 'WEEK_NOT_CLOSABLE_YET', `La semana ${week.weekNumber} se puede cerrar desde el ${when}`, { closableAt: opensAt });
  }
  const report = await closureReport(user, week);
  if (report.incompleteCount > 0 && !force) {
    throw new AppError(409, 'WEEK_INCOMPLETE', `${report.incompleteCount} áreas tienen datos sin llenar. ¿Cerrar de todas formas?`, report);
  }

  const monday = dateToDay(week.mondayDate);
  // Where unfinished work goes (creating it also copies this week's KPIs/functions).
  const { week: next } = await ensureWeek(user.workspaceId, addDays(monday, 7), user.id);

  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`week-close:${week.id}`}))`;
      const fresh = await tx.week.findUniqueOrThrow({ where: { id: week.id } });
      if (fresh.status === 'ARCHIVED') throw weekClosedError();

      const snapshot = await buildWeekData(tx, fresh, user.workspaceTimezone, null);
      snapshot.week.status = 'ARCHIVED';

      const unfinished = { weekId: week.id, deletedAt: null, progress: { lt: 100 } } satisfies Prisma.TaskWhereInput;
      const firstCarry = await tx.task.updateMany({
        where: { ...unfinished, carriedFromWeekId: null },
        data: { weekId: next.id, carriedFromWeekId: week.id },
      });
      const again = await tx.task.updateMany({ where: unfinished, data: { weekId: next.id } });

      await tx.weeklyArchive.create({
        data: {
          workspaceId: user.workspaceId,
          weekId: week.id,
          weekStart: week.mondayDate,
          weekEnd: dayToDate(saturdayOf(monday)),
          data: snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      await takeKpiSnapshot(tx, user.workspaceId, week.id, snapshot);
      const archived = await tx.week.update({
        where: { id: week.id },
        data: { status: 'ARCHIVED', archivedAt: new Date(), archivedById: user.id },
      });
      const carried = firstCarry.count + again.count;
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.WEEK_CLOSED,
          entityType: 'Week',
          entityId: week.id,
          metadata: {
            weekNumber: week.weekNumber,
            index: snapshot.overall.index,
            carriedTasks: carried,
            incompleteAreas: report.incompleteCount,
            forced: report.incompleteCount > 0,
          },
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
      return { archived, carried, snapshot };
    },
    { timeout: 30_000 },
  );

  emitTo([rooms.workspace(user.workspaceId)], 'week:closed', {
    week: presentWeek(outcome.archived),
    nextWeekId: next.id,
    carriedTasks: outcome.carried,
  });
  // The week's Excel report, from the snapshot just frozen. A failure is
  // logged and audited but never undoes the closing (report: null).
  const weeklyReport = await generateOnClose(user, week.id, ctx.ipAddress);
  return {
    report: weeklyReport,
    week: presentWeek(outcome.archived),
    nextWeek: presentWeek(next),
    carriedTasks: outcome.carried,
    overall: outcome.snapshot.overall,
    incompleteAreas: report.incompleteCount,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

// Makes sure every workspace has its current week. Runs every minute, so a
// new week appears within a minute of Monday 00:00 local time (and on boot).
export async function ensureCurrentWeeks(now = new Date()) {
  const workspaces = await prisma.workspace.findMany({ where: { deletedAt: null }, select: { id: true, timezone: true } });
  let created = 0;
  for (const ws of workspaces) {
    try {
      if ((await ensureWeek(ws.id, mondayOf(now, ws.timezone))).created) created++;
    } catch (error) {
      logger.error('weekly scheduler failed', { error, workspaceId: ws.id });
    }
  }
  if (created) logger.info('weeks created', { count: created });
  return created;
}

export function startWeekScheduler(intervalMs = 60_000) {
  const run = () => void ensureCurrentWeeks().catch((error) => logger.error('weekly scheduler crashed', { error }));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
