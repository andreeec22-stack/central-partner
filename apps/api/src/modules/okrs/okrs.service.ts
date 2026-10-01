import type { Okr, Prisma } from '@prisma/client';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { dateToDay, dayToDate, localDay } from '../../lib/week';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { invalidateScorecard } from '../scorecard/scorecard.service';
import { expectedFraction, keyResultProgress, okrProgress, okrStatus, quarterBounds, type OkrStatus } from './okr-progress';
import { canCheckIn, canManageOkr, canSeeOkr, okrVisibilityFilter, type OkrRef } from './okrs.access';
import type { CheckInInput, CreateOkrInput, KeyResultInput, ListOkrsQuery, UpdateOkrInput } from './okrs.schemas';

// Quarterly OKRs in a cascade COMPANY → AREA → PERSON. A parent must be one
// level up, in the same quarter (and, for a PERSON, of the same area). Level,
// area and owner never change after creation; progress is recomputed from the
// key results on every write and the status is derived on read (okr-progress.ts).

const include = {
  department: { select: { id: true, name: true, color: true } },
  owner: { select: { id: true, displayName: true, role: true } },
  keyResults: { orderBy: { order: 'asc' as const } },
  _count: { select: { children: true } },
  checkIns: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
} satisfies Prisma.OkrInclude;
type OkrRow = Prisma.OkrGetPayload<{ include: typeof include }>;

const PARENT_LEVEL = { COMPANY: null, AREA: 'COMPANY', PERSON: 'AREA' } as const;

export function presentOkr(user: AuthUser, o: OkrRow, today = localDay(new Date(), user.workspaceTimezone)) {
  const deadline = o.deadline ? dateToDay(o.deadline) : null;
  return {
    id: o.id,
    period: o.period,
    level: o.level,
    parentId: o.parentId,
    department: o.department,
    owner: o.owner ? { id: o.owner.id, displayName: o.owner.displayName } : null,
    title: o.title,
    description: o.description,
    deadline,
    progress: o.progress,
    expectedProgress: Math.round(expectedFraction(o.period, deadline, today) * 1000) / 10,
    status: okrStatus(o.progress, o.period, deadline, today) as OkrStatus,
    completedAt: o.completedAt,
    childrenCount: o._count.children,
    lastCheckInAt: o.checkIns[0]?.createdAt ?? null,
    keyResults: o.keyResults.map((kr) => ({
      id: kr.id,
      title: kr.title,
      unit: kr.unit,
      startValue: kr.startValue,
      target: kr.target,
      current: kr.current,
      progress: keyResultProgress(kr),
    })),
    permissions: { canEdit: canManageOkr(user, o), canCheckIn: canCheckIn(user, o) },
  };
}
export type OkrView = ReturnType<typeof presentOkr>;

async function findVisible(user: AuthUser, id: string): Promise<OkrRow> {
  const o = await prisma.okr.findFirst({ where: { id, workspaceId: user.workspaceId }, include });
  if (!o) throw notFound('OKR');
  if (!canSeeOkr(user, o)) throw forbidden('No tienes acceso a este objetivo');
  return o;
}

function broadcast(workspaceId: string, o: Pick<Okr, 'id' | 'period'>) {
  emitTo([rooms.workspace(workspaceId)], 'okr:changed', { okrId: o.id, period: o.period });
}

async function afterChange(workspaceId: string, o: Pick<Okr, 'id' | 'period' | 'departmentId'>) {
  await invalidateScorecard(workspaceId, o.period, o.departmentId);
  broadcast(workspaceId, o);
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function listOkrs(user: AuthUser, q: ListOkrsQuery) {
  const rows = await prisma.okr.findMany({
    where: {
      AND: [
        okrVisibilityFilter(user),
        {
          period: q.period,
          ...(q.level ? { level: q.level } : {}),
          ...(q.departmentId ? { departmentId: q.departmentId } : {}),
          ...(q.ownerUserId ? { ownerUserId: q.ownerUserId } : {}),
        },
      ],
    },
    include,
    orderBy: [{ level: 'asc' }, { createdAt: 'asc' }],
  });
  const today = localDay(new Date(), user.workspaceTimezone);
  return { data: rows.map((o) => presentOkr(user, o, today)) };
}

type TreeNode = OkrView & { children: TreeNode[] };

// The quarter as a forest: company objectives with their areas and people
// underneath. An OKR whose parent the viewer can't see (or that has none) is a root.
export async function okrTree(user: AuthUser, period: string) {
  const { data } = await listOkrs(user, { period });
  const nodes = new Map<string, TreeNode>(data.map((o) => [o.id, { ...o, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const summary: Record<OkrStatus, number> & { total: number } = { ON_TRACK: 0, AT_RISK: 0, OFF_TRACK: 0, COMPLETED: 0, total: data.length };
  for (const o of data) summary[o.status]++;
  return { period, summary, roots };
}

export async function getOkr(user: AuthUser, id: string) {
  const o = await findVisible(user, id);
  const checkIns = await prisma.okrCheckIn.findMany({
    where: { okrId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { author: { select: { id: true, displayName: true } } },
  });
  return { okr: presentOkr(user, o), checkIns: checkIns.map(presentCheckIn) };
}

function presentCheckIn(c: Prisma.OkrCheckInGetPayload<{ include: { author: { select: { id: true; displayName: true } } } }>) {
  return { id: c.id, progress: c.progress, values: c.values, notes: c.notes, author: c.author, createdAt: c.createdAt };
}

export async function listCheckIns(user: AuthUser, id: string) {
  return { data: (await getOkr(user, id)).checkIns };
}

// ─── Write ──────────────────────────────────────────────────────────────────

function assertDeadlineInQuarter(period: string, deadline: string | null | undefined) {
  if (!deadline) return;
  const { start, end } = quarterBounds(period);
  if (deadline < start || deadline > end) {
    throw validationError('La fecha límite debe caer dentro del trimestre', [{ field: 'deadline', message: `${start} – ${end}` }]);
  }
}

async function assertParent(db: Tx, user: AuthUser, child: OkrRef & { period: string; id?: string }, parentId: string | null | undefined) {
  if (!parentId) return;
  const parent = await db.okr.findFirst({ where: { id: parentId, workspaceId: user.workspaceId }, select: { id: true, level: true, period: true, departmentId: true } });
  const expected = PARENT_LEVEL[child.level];
  const problem = !parent
    ? 'El objetivo padre no existe'
    : parent.id === child.id
      ? 'Un objetivo no puede ser su propio padre'
      : parent.level !== expected
        ? `Un objetivo ${child.level === 'AREA' ? 'de área cuelga de uno de empresa' : 'personal cuelga de uno de área'}`
        : parent.period !== child.period
          ? 'El objetivo padre debe ser del mismo trimestre'
          : child.level === 'PERSON' && parent.departmentId !== child.departmentId
            ? 'El objetivo padre debe ser del área de la persona'
            : null;
  if (expected === null) throw validationError('Los objetivos de empresa no tienen padre', [{ field: 'parentId', message: 'COMPANY' }]);
  if (problem) throw validationError(problem, [{ field: 'parentId', message: problem }]);
}

function krRows(input: KeyResultInput[], existing: Map<string, number> = new Map()) {
  return input.map((kr, order) => ({
    title: kr.title,
    unit: kr.unit ?? null,
    startValue: kr.startValue,
    target: kr.target,
    // A kept key result keeps its current value; a new one starts at its start value.
    current: kr.id && existing.has(kr.id) ? existing.get(kr.id)! : kr.startValue,
    order,
  }));
}

const audit = (user: AuthUser, ctx: ClientContext, okrId: string) => ({
  workspaceId: user.workspaceId,
  userId: user.id,
  entityType: 'Okr',
  entityId: okrId,
  ipAddress: ctx.ipAddress,
});

export async function createOkr(user: AuthUser, input: CreateOkrInput, ctx: ClientContext) {
  let departmentId: string | null = null;
  let ownerUserId: string | null = null;
  let owner: { role: AuthUser['role'] } | null = null;

  if (input.level === 'AREA') {
    if (!input.departmentId) throw validationError('Elige el área', [{ field: 'departmentId', message: 'required' }]);
    const dept = await prisma.department.findFirst({ where: { id: input.departmentId, workspaceId: user.workspaceId, deletedAt: null }, select: { id: true } });
    if (!dept) throw validationError('Área no encontrada', [{ field: 'departmentId', message: 'not found' }]);
    departmentId = dept.id;
  } else if (input.level === 'PERSON') {
    if (!input.ownerUserId) throw validationError('Elige a la persona', [{ field: 'ownerUserId', message: 'required' }]);
    const person = await prisma.user.findFirst({
      where: { id: input.ownerUserId, workspaceId: user.workspaceId, deletedAt: null },
      select: { id: true, role: true, departmentId: true },
    });
    if (!person?.departmentId) throw validationError('La persona debe existir y tener área', [{ field: 'ownerUserId', message: 'invalid' }]);
    departmentId = person.departmentId;
    ownerUserId = person.id;
    owner = { role: person.role };
  }

  const ref: OkrRef = { level: input.level, departmentId, ownerUserId, owner };
  if (!canManageOkr(user, ref)) throw forbidden('No puedes crear este objetivo');
  assertDeadlineInQuarter(input.period, input.deadline);

  const okr = await prisma.$transaction(async (tx) => {
    await assertParent(tx, user, { ...ref, period: input.period }, input.parentId);
    const rows = krRows(input.keyResults);
    const progress = okrProgress(rows);
    const created = await tx.okr.create({
      data: {
        workspaceId: user.workspaceId,
        period: input.period,
        level: input.level,
        parentId: input.parentId ?? null,
        departmentId,
        ownerUserId,
        title: input.title,
        description: input.description ?? null,
        deadline: input.deadline ? dayToDate(input.deadline) : null,
        progress,
        completedAt: progress >= 100 ? new Date() : null,
        createdById: user.id,
        keyResults: { create: rows },
      },
    });
    await logActivity({ ...audit(user, ctx, created.id), action: ActivityAction.OKR_CREATED, metadata: { title: created.title, level: created.level, period: created.period } }, tx);
    return created;
  });
  await afterChange(user.workspaceId, okr);
  return { okr: presentOkr(user, await findVisible(user, okr.id)) };
}

export async function updateOkr(user: AuthUser, id: string, input: UpdateOkrInput, ctx: ClientContext) {
  const current = await findVisible(user, id);
  if (!canManageOkr(user, current)) throw forbidden('No puedes editar este objetivo');
  if (input.deadline !== undefined) assertDeadlineInQuarter(current.period, input.deadline);

  await prisma.$transaction(async (tx) => {
    if (input.parentId !== undefined) await assertParent(tx, user, { ...current, id }, input.parentId);
    let progress = current.progress;
    if (input.keyResults) {
      const unknown = input.keyResults.find((kr) => kr.id && !current.keyResults.some((k) => k.id === kr.id));
      if (unknown) throw validationError('Resultado clave desconocido', [{ field: 'keyResults', message: unknown.id! }]);
      const rows = krRows(input.keyResults, new Map(current.keyResults.map((k) => [k.id, k.current])));
      await tx.keyResult.deleteMany({ where: { okrId: id } });
      await tx.keyResult.createMany({ data: rows.map((r) => ({ ...r, okrId: id })) });
      progress = okrProgress(rows);
    }
    const data: Prisma.OkrUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline ? dayToDate(input.deadline) : null } : {}),
      ...(input.parentId !== undefined ? { parent: input.parentId ? { connect: { id: input.parentId } } : { disconnect: true } } : {}),
      progress,
      completedAt: progress >= 100 ? (current.completedAt ?? new Date()) : null,
    };
    await tx.okr.update({ where: { id }, data });
    const changes = diffFields(
      { title: current.title, description: current.description, deadline: current.deadline ? dateToDay(current.deadline) : null, parentId: current.parentId, progress: current.progress },
      { title: input.title, description: input.description, deadline: input.deadline, parentId: input.parentId, progress },
    );
    await logActivity({ ...audit(user, ctx, id), action: ActivityAction.OKR_UPDATED, changes, metadata: { title: input.title ?? current.title, keyResultsReplaced: !!input.keyResults } }, tx);
  });
  await afterChange(user.workspaceId, current);
  return { okr: presentOkr(user, await findVisible(user, id)) };
}

export async function deleteOkr(user: AuthUser, id: string, ctx: ClientContext) {
  const current = await findVisible(user, id);
  if (!canManageOkr(user, current)) throw forbidden('No puedes eliminar este objetivo');
  if (current._count.children > 0) {
    throw new AppError(409, 'OKR_HAS_CHILDREN', 'Primero elimina o mueve los objetivos que cuelgan de este');
  }
  await prisma.$transaction(async (tx) => {
    await tx.okr.delete({ where: { id } });
    await logActivity({ ...audit(user, ctx, id), action: ActivityAction.OKR_DELETED, metadata: { title: current.title, level: current.level, period: current.period } }, tx);
  });
  await afterChange(user.workspaceId, current);
}

export async function checkIn(user: AuthUser, id: string, input: CheckInInput, ctx: ClientContext) {
  const current = await findVisible(user, id);
  if (!canCheckIn(user, current)) throw forbidden('No puedes registrar avances en este objetivo');
  const byId = new Map(current.keyResults.map((k) => [k.id, k]));
  const unknown = input.keyResults.find((kr) => !byId.has(kr.id));
  if (unknown) throw validationError('Resultado clave desconocido', [{ field: 'keyResults', message: unknown.id }]);

  const values = input.keyResults.map((kr) => ({ keyResultId: kr.id, previous: byId.get(kr.id)!.current, current: kr.current }));
  const updated = current.keyResults.map((k) => ({ ...k, current: input.keyResults.find((kr) => kr.id === k.id)?.current ?? k.current }));
  const progress = okrProgress(updated);

  await prisma.$transaction(async (tx) => {
    for (const v of values) await tx.keyResult.update({ where: { id: v.keyResultId }, data: { current: v.current } });
    await tx.okr.update({ where: { id }, data: { progress, completedAt: progress >= 100 ? (current.completedAt ?? new Date()) : null } });
    await tx.okrCheckIn.create({ data: { okrId: id, authorId: user.id, progress, values, notes: input.notes ?? null } });
    await logActivity(
      { ...audit(user, ctx, id), action: ActivityAction.OKR_CHECKED_IN, changes: { progress: { old: current.progress, new: progress } }, metadata: { title: current.title, values } },
      tx,
    );
  });
  await afterChange(user.workspaceId, current);
  return getOkr(user, id);
}
