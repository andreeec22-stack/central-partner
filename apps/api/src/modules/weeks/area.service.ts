import type { Department, Week } from '@prisma/client';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors';
import { canSeeDepartment, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { dateToDay, localDay, saturdayOf } from '../../lib/week';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import type { CreateFunctionInput, CreateKpiInput, UpdateFunctionInput, UpdateKpiInput } from './area.schemas';
import { buildWeekData } from './week-data';
import { resolveWeek, weekClosedError } from './weeks.service';

// ② KPIs and ③ functions of an area, per week.
//   read:    anyone who can see the department
//   define:  its JEFE_AREA or an ADMIN, while the week is open
//   results: the KPI real value and the Sí/Parcial/No mark are Saturday work —
//            the JEFE_AREA from that week's Saturday until it is closed, an
//            ADMIN any day before closing (to correct mistakes)

export function canManageArea(user: AuthUser, departmentId: string) {
  return user.role === 'ADMIN' || (user.role === 'JEFE_AREA' && user.departmentId === departmentId);
}

function assertCanRecordResults(user: AuthUser, departmentId: string, week: Week, now = new Date()) {
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador registran resultados');
  if (user.role === 'ADMIN') return;
  const saturday = saturdayOf(dateToDay(week.mondayDate));
  if (localDay(now, user.workspaceTimezone) < saturday) {
    throw new AppError(403, 'RESULTS_ON_SATURDAY', `Los resultados de la semana se registran a partir del sábado ${saturday}`);
  }
}

async function visibleDepartment(user: AuthUser, departmentId: string): Promise<Department> {
  const scope = await departmentScope(user);
  const dept = await prisma.department.findFirst({ where: { id: departmentId, workspaceId: user.workspaceId, deletedAt: null } });
  if (!dept || !canSeeDepartment(scope, dept.id)) throw notFound('Department');
  return dept;
}

async function writableWeek(user: AuthUser, ref: string | undefined) {
  const week = await resolveWeek(user, ref);
  if (week.status === 'ARCHIVED') throw weekClosedError();
  return week;
}

async function areaView(user: AuthUser, departmentId: string, week: Week) {
  const data = await buildWeekData(prisma, week, user.workspaceTimezone, [departmentId]);
  return data.departments[0]!;
}

function broadcast(event: 'kpi:changed' | 'function:changed', user: AuthUser, departmentId: string, weekId: string) {
  emitTo([rooms.admins(user.workspaceId), rooms.department(departmentId)], event, { departmentId, weekId });
}

// ─── KPIs ───────────────────────────────────────────────────────────────────

export async function listKpis(user: AuthUser, departmentId: string, weekRef?: string) {
  await visibleDepartment(user, departmentId);
  const week = await resolveWeek(user, weekRef);
  const area = await areaView(user, departmentId, week);
  return { weekId: week.id, data: area.kpis, kpiCompliance: area.metrics.kpiCompliance };
}

async function findKpi(user: AuthUser, departmentId: string, kpiId: string) {
  const kpi = await prisma.kpi.findFirst({
    where: { id: kpiId, departmentId, workspaceId: user.workspaceId },
    include: { week: true },
  });
  if (!kpi) throw notFound('KPI');
  if (kpi.week.status === 'ARCHIVED') throw weekClosedError();
  return kpi;
}

async function presentOne(user: AuthUser, departmentId: string, week: Week, kpiId: string) {
  return (await areaView(user, departmentId, week)).kpis.find((k) => k.id === kpiId)!;
}

export async function createKpi(user: AuthUser, departmentId: string, input: CreateKpiInput, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador definen KPIs');
  const week = await writableWeek(user, input.weekId);
  const order = input.order ?? (await prisma.kpi.count({ where: { weekId: week.id, departmentId } }));
  const kpi = await prisma.$transaction(async (tx) => {
    const kpi = await tx.kpi.create({
      data: {
        workspaceId: user.workspaceId,
        weekId: week.id,
        departmentId,
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        unit: input.unit ?? null,
        target: input.target,
        lesserIsBetter: input.lesserIsBetter,
        order,
        createdById: user.id,
      },
    });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.KPI_CREATED,
        entityType: 'Kpi',
        entityId: kpi.id,
        metadata: { departmentId, weekId: week.id, title: kpi.title, target: input.target },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return kpi;
  });
  broadcast('kpi:changed', user, departmentId, week.id);
  return { kpi: await presentOne(user, departmentId, week, kpi.id) };
}

export async function updateKpi(user: AuthUser, departmentId: string, kpiId: string, patch: UpdateKpiInput, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  const kpi = await findKpi(user, departmentId, kpiId);
  const { actual, ...definition } = patch;
  if (Object.keys(definition).length && !canManageArea(user, departmentId)) {
    throw forbidden('Solo el jefe del área o un administrador editan KPIs');
  }
  if (actual !== undefined) assertCanRecordResults(user, departmentId, kpi.week);

  const lesserIsBetter = definition.lesserIsBetter ?? kpi.lesserIsBetter;
  const target = definition.target ?? Number(kpi.target);
  if (!lesserIsBetter && target <= 0) {
    throw validationError('The target must be greater than 0', [{ field: 'target', message: 'must be > 0' }]);
  }

  const before = { ...kpi, target: Number(kpi.target), actual: kpi.actual === null ? null : Number(kpi.actual) };
  const changes = diffFields(before as unknown as Record<string, unknown>, { ...definition, ...(actual !== undefined ? { actual } : {}) });
  if (Object.keys(changes).length) {
    await prisma.$transaction(async (tx) => {
      await tx.kpi.update({
        where: { id: kpi.id },
        data: {
          ...definition,
          ...(actual !== undefined ? { actual, recordedAt: actual === null ? null : new Date(), recordedById: actual === null ? null : user.id } : {}),
        },
      });
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: actual !== undefined && Object.keys(definition).length === 0 ? ActivityAction.KPI_RECORDED : ActivityAction.KPI_UPDATED,
          entityType: 'Kpi',
          entityId: kpi.id,
          changes,
          metadata: { departmentId, weekId: kpi.weekId, title: kpi.title },
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
    });
    broadcast('kpi:changed', user, departmentId, kpi.weekId);
  }
  return { kpi: await presentOne(user, departmentId, kpi.week, kpi.id) };
}

export async function deleteKpi(user: AuthUser, departmentId: string, kpiId: string, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador eliminan KPIs');
  const kpi = await findKpi(user, departmentId, kpiId);
  await prisma.$transaction(async (tx) => {
    await tx.kpi.delete({ where: { id: kpi.id } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.KPI_DELETED,
        entityType: 'Kpi',
        entityId: kpi.id,
        metadata: { departmentId, weekId: kpi.weekId, title: kpi.title, target: Number(kpi.target), actual: kpi.actual === null ? null : Number(kpi.actual) },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  broadcast('kpi:changed', user, departmentId, kpi.weekId);
}

// Earlier KPI definitions of the areas the caller can see, newest first, one per
// area + title — to add a KPI without retyping it.
export async function kpiTemplates(user: AuthUser) {
  const scope = await departmentScope(user);
  const rows = await prisma.kpi.findMany({
    where: { workspaceId: user.workspaceId, ...(scope.all ? {} : { departmentId: { in: scope.departmentIds } }) },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { departmentId: true, title: true, description: true, type: true, unit: true, target: true, lesserIsBetter: true },
  });
  const seen = new Set<string>();
  const data = [];
  for (const r of rows) {
    const key = `${r.departmentId}:${r.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    data.push({ ...r, target: Number(r.target) });
  }
  return { data };
}

// ─── Functions ──────────────────────────────────────────────────────────────

export async function listFunctions(user: AuthUser, departmentId: string, weekRef?: string) {
  await visibleDepartment(user, departmentId);
  const week = await resolveWeek(user, weekRef);
  const area = await areaView(user, departmentId, week);
  return { weekId: week.id, data: area.functions, functionCompliance: area.metrics.functionCompliance };
}

async function findFunction(user: AuthUser, departmentId: string, functionId: string) {
  const fn = await prisma.departmentFunction.findFirst({
    where: { id: functionId, departmentId, workspaceId: user.workspaceId },
    include: { week: true },
  });
  if (!fn) throw notFound('Function');
  if (fn.week.status === 'ARCHIVED') throw weekClosedError();
  return fn;
}

export async function createFunction(user: AuthUser, departmentId: string, input: CreateFunctionInput, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador definen funciones');
  const week = await writableWeek(user, input.weekId);
  const order = input.order ?? (await prisma.departmentFunction.count({ where: { weekId: week.id, departmentId } }));
  const fn = await prisma.$transaction(async (tx) => {
    const fn = await tx.departmentFunction.create({
      data: {
        workspaceId: user.workspaceId,
        weekId: week.id,
        departmentId,
        title: input.title,
        description: input.description ?? null,
        frequency: input.frequency,
        order,
        createdById: user.id,
      },
    });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.FUNCTION_CREATED,
        entityType: 'DepartmentFunction',
        entityId: fn.id,
        metadata: { departmentId, weekId: week.id, title: fn.title },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return fn;
  });
  broadcast('function:changed', user, departmentId, week.id);
  return { function: (await areaView(user, departmentId, week)).functions.find((f) => f.id === fn.id)! };
}

export async function updateFunction(user: AuthUser, departmentId: string, functionId: string, patch: UpdateFunctionInput, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  const fn = await findFunction(user, departmentId, functionId);
  const { fulfilled, ...rest } = patch;
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador editan funciones');
  if (fulfilled !== undefined) assertCanRecordResults(user, departmentId, fn.week);

  const changes = diffFields(fn as unknown as Record<string, unknown>, { ...rest, ...(fulfilled !== undefined ? { fulfilled } : {}) });
  if (Object.keys(changes).length) {
    await prisma.$transaction(async (tx) => {
      await tx.departmentFunction.update({
        where: { id: fn.id },
        data: {
          ...rest,
          ...(fulfilled !== undefined ? { fulfilled, markedAt: fulfilled === null ? null : new Date(), markedById: fulfilled === null ? null : user.id } : {}),
        },
      });
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: fulfilled !== undefined && Object.keys(rest).length === 0 ? ActivityAction.FUNCTION_MARKED : ActivityAction.FUNCTION_UPDATED,
          entityType: 'DepartmentFunction',
          entityId: fn.id,
          changes,
          metadata: { departmentId, weekId: fn.weekId, title: fn.title },
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
    });
    broadcast('function:changed', user, departmentId, fn.weekId);
  }
  return { function: (await areaView(user, departmentId, fn.week)).functions.find((f) => f.id === fn.id)! };
}

export async function deleteFunction(user: AuthUser, departmentId: string, functionId: string, ctx: ClientContext) {
  await visibleDepartment(user, departmentId);
  if (!canManageArea(user, departmentId)) throw forbidden('Solo el jefe del área o un administrador eliminan funciones');
  const fn = await findFunction(user, departmentId, functionId);
  await prisma.$transaction(async (tx) => {
    await tx.departmentFunction.delete({ where: { id: fn.id } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.FUNCTION_DELETED,
        entityType: 'DepartmentFunction',
        entityId: fn.id,
        metadata: { departmentId, weekId: fn.weekId, title: fn.title, fulfilled: fn.fulfilled },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  broadcast('function:changed', user, departmentId, fn.weekId);
}
