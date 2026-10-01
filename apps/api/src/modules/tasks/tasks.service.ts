import type { Prisma, Task } from '@prisma/client';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors';
import {
  canContribute,
  canCreateTaskIn,
  canCreateTasks,
  canDeleteTask,
  canEditTask,
  canSeeDepartment,
  departmentFilter,
  departmentScope,
  type DepartmentScope,
} from '../../lib/permissions';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, emitToExcept, taskRooms } from '../../lib/realtime';
import { weekRange } from '../../lib/time';
import { dateToDay, localDay } from '../../lib/week';
import { taskDay, taskSemaphore } from '../../lib/weekly-metrics';
import { notifySafely } from '../notifications/notify.service';
import { assertWeekOpen, currentWeek, weekClosedError, weekForTask } from '../weeks/weeks.service';
import { commentInclude, presentComment } from './comments.service';
import { fileInclude, presentFile } from './files.service';
import { mentionableUsers } from './mentions';
import { findVisibleTask } from './task-access';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity, type FieldChanges } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { createsParentCycle, findCycle } from './dependency-graph';
import { deriveTaskState, type TaskStateEvents } from './task-state';
import type { BulkUpdateInput, CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './tasks.schemas';

// ─── Presentation ───────────────────────────────────────────────────────────

const taskInclude = {
  assignedTo: { select: { id: true, displayName: true } },
  createdBy: { select: { id: true, displayName: true } },
  department: { select: { id: true, name: true, color: true } },
  week: { select: { id: true, mondayDate: true, weekNumber: true, year: true, status: true } },
  carriedFrom: { select: { id: true, weekNumber: true, year: true } },
  observations: { select: { weekId: true, observation: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 3 },
  _count: {
    select: {
      subTasks: { where: { deletedAt: null } },
      comments: { where: { deletedAt: null } },
      files: { where: { deletedAt: null } },
    },
  },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

// Adds what depends on "today": the date-based semaphore and the task's day.
export function presentTask(t: TaskRow, timeZone: string, now = new Date()) {
  const { _count, deletedAt: _deleted, collaborationParticipantIds: _participants, observations, week, ...rest } = t;
  const monday = week ? dateToDay(week.mondayDate) : null;
  return {
    ...rest,
    day: taskDay(t, monday, timeZone),
    semaphore: taskSemaphore(t, monday, localDay(now, timeZone), timeZone),
    week: week ? { id: week.id, weekNumber: week.weekNumber, year: week.year, mondayDate: monday, status: week.status } : null,
    // This week's note (observations are per week, so a new week starts clean).
    observation: observations.find((o) => o.weekId === t.weekId)?.observation ?? null,
    counts: _count,
  };
}

// Compact task references (sub-tasks, dependencies) with their semaphore.
const refSelect = {
  id: true,
  title: true,
  status: true,
  progress: true,
  dueDate: true,
  week: { select: { mondayDate: true } },
} satisfies Prisma.TaskSelect;

function presentRef(t: Prisma.TaskGetPayload<{ select: typeof refSelect }>, timeZone: string, today: string) {
  const { week, dueDate: _due, ...rest } = t;
  const monday = week ? dateToDay(week.mondayDate) : null;
  return { ...rest, semaphore: taskSemaphore(t, monday, today, timeZone) };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

interface OpContext {
  tx: Tx;
  user: AuthUser;
  scope: DepartmentScope;
  now: Date;
  // Per-request memo so bulk updates don't re-validate the same assignee 100 times.
  memo: Map<string, Promise<void>>;
}

function memoized(ctx: OpContext, key: string, check: () => Promise<void>) {
  let pending = ctx.memo.get(key);
  if (!pending) {
    pending = check();
    ctx.memo.set(key, pending);
  }
  return pending;
}

function assertActiveDepartment(ctx: OpContext, departmentId: string) {
  return memoized(ctx, `dept:${departmentId}`, async () => {
    const found = await ctx.tx.department.count({
      where: { id: departmentId, workspaceId: ctx.user.workspaceId, deletedAt: null },
    });
    if (!found) throw validationError('Department not found', [{ field: 'departmentId', message: 'invalid' }]);
  });
}

// One assignee (Confirmación A), active, not a VIEWER, and a member of the
// task's department — ADMINs (the director) can be assigned anywhere.
function assertAssignee(ctx: OpContext, departmentId: string, assigneeId: string) {
  return memoized(ctx, `assignee:${assigneeId}:${departmentId}`, async () => {
    const assignee = await ctx.tx.user.findFirst({
      where: { id: assigneeId, workspaceId: ctx.user.workspaceId, deletedAt: null },
      select: { role: true, departmentId: true },
    });
    const field = [{ field: 'assignedTo', message: 'invalid' }];
    if (!assignee) throw validationError('Assignee must be an active user of this workspace', field);
    if (assignee.role === 'VIEWER') throw validationError('Viewers cannot be assigned tasks', field);
    if (assignee.role !== 'ADMIN' && assignee.departmentId !== departmentId) {
      throw validationError("Assignee must belong to the task's department", field);
    }
  });
}

async function assertParent(ctx: OpContext, taskId: string | null, parentId: string) {
  await findVisibleTask(ctx.tx, ctx.user, ctx.scope, parentId).catch(() => {
    throw validationError('Parent task not found', [{ field: 'parentTaskId', message: 'invalid' }]);
  });
  if (!taskId) return;
  const links = await ctx.tx.task.findMany({
    where: { workspaceId: ctx.user.workspaceId, parentTaskId: { not: null } },
    select: { id: true, parentTaskId: true },
  });
  const parentOf = new Map((links as any).map((l: any) => [l.id, l.parentTaskId] as [string, string | null]));
  if (createsParentCycle(taskId, parentId, (id) => (parentOf.get(id) as string | null | undefined))) {
    throw validationError('A task cannot be nested under itself or one of its sub-tasks', [
      { field: 'parentTaskId', message: 'circular' },
    ]);
  }
}

// ─── Update planning (shared by PATCH and bulk) ─────────────────────────────

interface UpdatePlan {
  data: Prisma.TaskUncheckedUpdateInput;
  changes: FieldChanges;
  events: TaskStateEvents;
}

const STATE_FIELDS = ['status', 'progress', 'priority', 'blockReason', 'dueDate', 'kpiActual'] as const;

// `targetWeekId`: the week of a new due date (resolved before the transaction).
async function planUpdate(ctx: OpContext, task: Task, patch: UpdateTaskInput, targetWeekId?: string): Promise<UpdatePlan> {
  const { user } = ctx;
  const data: Prisma.TaskUncheckedUpdateInput = {};
  if (targetWeekId && targetWeekId !== task.weekId) data.weekId = targetWeekId;

  if (patch.departmentId !== undefined && patch.departmentId !== task.departmentId) {
    if (user.role !== 'ADMIN') throw forbidden('Only an administrator can move a task to another department');
    await assertActiveDepartment(ctx, patch.departmentId);
    data.departmentId = patch.departmentId;
  }
  const departmentAfter = patch.departmentId ?? task.departmentId;
  const assigneeAfter = patch.assignedTo !== undefined ? patch.assignedTo : task.assignedToId;
  if (assigneeAfter && (patch.assignedTo !== undefined || data.departmentId !== undefined)) {
    await assertAssignee(ctx, departmentAfter, assigneeAfter);
  }
  if (patch.assignedTo !== undefined) data.assignedToId = patch.assignedTo;

  if (patch.parentTaskId !== undefined && patch.parentTaskId !== task.parentTaskId) {
    if (patch.parentTaskId) await assertParent(ctx, task.id, patch.parentTaskId);
    data.parentTaskId = patch.parentTaskId;
  }

  for (const key of ['title', 'description', 'priority', 'dueDate', 'kpiTarget', 'kpiActual'] as const) {
    if (patch[key] !== undefined) (data as Record<string, unknown>)[key] = patch[key];
  }

  const { change, events } = deriveTaskState(
    task,
    Object.fromEntries(STATE_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])),
    user.id,
    ctx.now,
  );
  Object.assign(data, change);

  const changes = diffFields(task as unknown as Record<string, unknown>, data as Record<string, unknown>);
  if (Object.keys(changes).length && !task.collaborationParticipantIds.includes(user.id)) {
    data.collaborationParticipantIds = { push: user.id };
  }
  return { data, changes, events };
}

function actionFor(events: TaskStateEvents) {
  if (events.blocked) return ActivityAction.TASK_BLOCKED;
  if (events.completed) return ActivityAction.TASK_COMPLETED;
  if (events.unblocked) return ActivityAction.TASK_UNBLOCKED;
  return ActivityAction.TASK_UPDATED;
}

function emitTaskUpdate(task: TaskRow, previous: Task, changes: FieldChanges, events: TaskStateEvents, timeZone: string) {
  const audience = taskRooms(task);
  const formerAudience = taskRooms(previous).filter((r) => !audience.includes(r));
  if (formerAudience.length) {
    emitToExcept(formerAudience, audience, 'task:updated', { taskId: task.id, removed: true });
  }
  const presented = presentTask(task, timeZone);
  emitTo(audience, 'task:updated', { taskId: task.id, changes, task: presented, updatedAt: task.updatedAt });
  if (events.progressChanged) {
    emitTo(audience, 'task:progress', { taskId: task.id, progress: task.progress, semaphore: presented.semaphore, weekId: task.weekId });
  }
  if (events.blocked) {
    emitTo(audience, 'task:blocked', {
      taskId: task.id,
      reason: task.blockReason,
      blockedSince: task.blockedSince,
      blockedByUserId: task.blockedByUserId,
    });
  }
  if (events.completed) {
    emitTo(audience, 'task:completed', {
      taskId: task.id,
      completedAt: task.actualCompletionDate,
      onTime: task.completionDelayDays === null ? null : task.completionDelayDays <= 0,
      completionDelayDays: task.completionDelayDays,
    });
  }
}

// In-app + WhatsApp heads-up for whoever just received the task.
function notifyAssignee(user: AuthUser, task: Pick<Task, 'id' | 'title' | 'workspaceId' | 'assignedToId'>, previousAssigneeId: string | null) {
  if (!task.assignedToId || task.assignedToId === previousAssigneeId) return Promise.resolve();
  return notifySafely({
    workspaceId: task.workspaceId,
    recipientIds: [task.assignedToId],
    type: 'TASK_ASSIGNED',
    actor: { id: user.id, displayName: user.displayName },
    task,
    title: `${user.displayName} te asignó "${task.title}"`,
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function listTasks(user: AuthUser, q: ListTasksQuery) {
  const scope = await departmentScope(user);
  if (q.departmentId && !canSeeDepartment(scope, q.departmentId)) throw forbidden('You cannot see that department');

  const and: Prisma.TaskWhereInput[] = [];
  if (q.search) {
    and.push({
      OR: [
        { title: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
        { kpiTarget: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  if (q.weekId) {
    const weekId = q.weekId === 'current' ? (await currentWeek(user.workspaceId, user.workspaceTimezone)).id : q.weekId;
    and.push({ weekId });
  }
  if (q.week) {
    // A task belongs to the week of its due date; undated tasks to the week they were written.
    const { start, end } = weekRange(q.week, user.timezone);
    and.push({ OR: [{ dueDate: { gte: start, lt: end } }, { dueDate: null, createdAt: { gte: start, lt: end } }] });
  }

  const statuses = q.status?.filter((s) => q.includeBlocked || s !== 'BLOCKED');
  const where: Prisma.TaskWhereInput = {
    workspaceId: user.workspaceId,
    deletedAt: null,
    departmentId: q.departmentId ?? departmentFilter(scope),
    ...(statuses ? { status: { in: statuses } } : q.includeBlocked ? {} : { status: { not: 'BLOCKED' } }),
    ...(q.priority ? { priority: { in: q.priority } } : {}),
    ...(q.assignedTo === 'me'
      ? { assignedToId: user.id }
      : q.assignedTo === 'unassigned'
        ? { assignedToId: null }
        : q.assignedTo
          ? { assignedToId: q.assignedTo }
          : {}),
    ...(q.parentTaskId ? { parentTaskId: q.parentTaskId } : {}),
    ...(q.sourceType ? { sourceType: q.sourceType } : {}),
    ...(and.length ? { AND: and } : {}),
  };

  const primary: Prisma.TaskOrderByWithRelationInput =
    q.sortBy === 'dueDate' ? { dueDate: { sort: q.sortOrder, nulls: 'last' } } : { [q.sortBy]: q.sortOrder };

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [primary, { id: 'asc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.task.count({ where }),
  ]);

  const { page, limit, ...filters } = q;
  const now = new Date();
  return { data: rows.map((t) => presentTask(t, user.workspaceTimezone, now)), total, page, limit, filters };
}

const DETAIL_ACTIVITY_LIMIT = 100;

// Everything the detail panel shows, in one round trip: the task, its comments
// and files (newest first), the last 100 audit entries and what the caller may do.
export async function getTaskDetail(user: AuthUser, id: string) {
  const scope = await departmentScope(user);
  const visible = await findVisibleTask(prisma, user, scope, id);

  const [task, comments, files, subTasks, dependencies, dependents, activity, people] = await Promise.all([
    prisma.task.findUniqueOrThrow({ where: { id }, include: taskInclude }),
    prisma.comment.findMany({
      where: { taskId: id, deletedAt: null },
      include: commentInclude,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.taskFile.findMany({ where: { taskId: id, deletedAt: null }, include: fileInclude, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({
      where: { parentTaskId: id, deletedAt: null },
      select: { ...refSelect, assignedToId: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.taskDependency.findMany({
      where: { taskId: id, dependsOn: { deletedAt: null } },
      select: { dependsOn: { select: refSelect } },
    }),
    prisma.taskDependency.findMany({
      where: { dependsOnTaskId: id, task: { deletedAt: null } },
      select: { task: { select: refSelect } },
    }),
    prisma.activityLog.findMany({
      where: { workspaceId: user.workspaceId, entityType: 'Task', entityId: id },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: DETAIL_ACTIVITY_LIMIT,
    }),
    mentionableUsers(prisma, visible.workspaceId, visible.departmentId),
  ]);
  const index = new Map(people.map((p) => [p.id, { id: p.id, displayName: p.displayName, handle: p.handle }]));
  const tz = user.workspaceTimezone;
  const today = localDay(new Date(), tz);
  // An archived week is read-only for everyone.
  const open = task.week?.status !== 'ARCHIVED';

  return {
    task: presentTask(task, tz),
    blockReason: task.blockReason,
    blockedSince: task.blockedSince,
    comments: comments.map((c) => presentComment(c, index)),
    files: await Promise.all(files.map(presentFile)),
    subTasks: subTasks.map(({ assignedToId, ...t }) => ({ ...presentRef(t, tz, today), assignedToId })),
    dependencies: dependencies.map((d) => presentRef(d.dependsOn, tz, today)),
    dependents: dependents.map((d) => presentRef(d.task, tz, today)),
    activity: activity.map((a) => ({
      id: a.id,
      taskId: id,
      action: a.action,
      entityType: a.entityType,
      userId: a.userId,
      changes: a.changes,
      metadata: a.metadata,
      timestamp: a.createdAt,
      user: a.user ? { id: a.user.id, name: a.user.displayName } : null,
    })),
    permissions: {
      canEdit: open && canEditTask(user, task),
      canComment: open && canContribute(user, task),
      canAddFiles: open && canContribute(user, task),
      canDelete: open && canDeleteTask(user, task),
      weekOpen: open,
    },
  };
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export async function createTask(user: AuthUser, input: CreateTaskInput, ctx: ClientContext) {
  if (!canCreateTasks(user)) throw forbidden('No tienes permiso para crear tareas');
  const departmentId = input.departmentId ?? user.departmentId;
  if (!departmentId) {
    throw validationError('Choose a department for the task', [{ field: 'departmentId', message: 'required' }]);
  }
  if (!canCreateTaskIn(user, departmentId)) throw forbidden('You can only create tasks in your own department');
  const assignedToId = input.assignedTo ?? null;
  const scope = await departmentScope(user);
  const week = await weekForTask(user.workspaceId, user.workspaceTimezone, input.dueDate ?? null, user.id);

  const task = await prisma.$transaction(async (tx) => {
    const op: OpContext = { tx, user, scope, now: new Date(), memo: new Map() };
    await assertActiveDepartment(op, departmentId);
    if (assignedToId) await assertAssignee(op, departmentId, assignedToId);
    if (input.parentTaskId) await assertParent(op, null, input.parentTaskId);

    const created = await tx.task.create({
      data: {
        workspaceId: user.workspaceId,
        departmentId,
        assignedToId,
        createdById: user.id,
        parentTaskId: input.parentTaskId ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        kpiTarget: input.kpiTarget ?? null,
        kpiActual: input.kpiActual ?? null,
        kpiRecordedAt: input.kpiActual ? op.now : null,
        progress: 0,
        weekId: week.id,
        sourceType: 'MANUAL',
        collaborationParticipantIds: [user.id],
      },
      include: taskInclude,
    });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.TASK_CREATED,
        entityType: 'Task',
        entityId: created.id,
        changes: {
          title: { old: null, new: created.title },
          departmentId: { old: null, new: created.departmentId },
          assignedToId: { old: null, new: created.assignedToId },
          priority: { old: null, new: created.priority },
        },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return created;
  });

  const payload = presentTask(task, user.workspaceTimezone);
  emitTo(taskRooms(task), 'task:created', {
    taskId: task.id,
    title: task.title,
    departmentId: task.departmentId,
    assignedTo: task.assignedToId,
    priority: task.priority,
    sourceType: task.sourceType,
    task: payload,
  });
  await notifyAssignee(user, task, null);
  return { task: payload };
}

export async function updateTask(user: AuthUser, id: string, input: UpdateTaskInput, ctx: ClientContext) {
  const { expectedUpdatedAt, ...patch } = input;
  const scope = await departmentScope(user);
  // A new date may move the task to another (open) week.
  const targetWeek = patch.dueDate ? await weekForTask(user.workspaceId, user.workspaceTimezone, patch.dueDate, user.id) : null;
  const result = await prisma.$transaction(async (tx) => {
    const op: OpContext = { tx, user, scope, now: new Date(), memo: new Map() };
    // Concurrent saves of the same task queue here, so the version check below
    // sees the committed result of the previous one.
    if (expectedUpdatedAt) await tx.$executeRaw`SELECT 1 FROM tasks WHERE id = ${id}::uuid FOR UPDATE`;
    const task = await findVisibleTask(tx, user, scope, id);
    if (!canEditTask(user, task)) throw forbidden('You can only edit tasks assigned to you or that you created');
    await assertWeekOpen(tx, task.weekId);
    if (expectedUpdatedAt && task.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new AppError(409, 'TASK_CONFLICT', 'Otra persona cambió esta tarea mientras la editabas; recarga para ver su versión', {
        updatedAt: task.updatedAt,
      });
    }

    const plan = await planUpdate(op, task, patch, targetWeek?.id);
    if (Object.keys(plan.changes).length === 0) {
      return { task: await tx.task.findUniqueOrThrow({ where: { id }, include: taskInclude }), previous: task, plan };
    }
    const updated = await tx.task.update({ where: { id }, data: plan.data, include: taskInclude });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: actionFor(plan.events),
        entityType: 'Task',
        entityId: id,
        changes: plan.changes,
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return { task: updated, previous: task, plan };
  });

  if (Object.keys(result.plan.changes).length) {
    emitTaskUpdate(result.task, result.previous, result.plan.changes, result.plan.events, user.workspaceTimezone);
    await notifyAssignee(user, result.task, result.previous.assignedToId);
  }
  return { task: presentTask(result.task, user.workspaceTimezone) };
}

// Gap 13: all-or-nothing. Every task is validated first; if any fails, nothing
// is written and the caller gets the per-task reasons.
export async function bulkUpdateTasks(user: AuthUser, input: BulkUpdateInput, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const dueDate = input.updates.dueDate;
  const targetWeek = dueDate ? await weekForTask(user.workspaceId, user.workspaceTimezone, dueDate, user.id) : null;
  const results = await prisma.$transaction(
    async (tx) => {
      const op: OpContext = { tx, user, scope, now: new Date(), memo: new Map() };
      const tasks = await tx.task.findMany({
        where: { id: { in: input.taskIds }, workspaceId: user.workspaceId, deletedAt: null, departmentId: departmentFilter(scope) },
        include: { week: { select: { status: true } } },
      });
      const byId = new Map(tasks.map((t: any) => [t.id, t]));
      const failed: { taskId: string; code: string; reason: string }[] = [];
      const plans: { task: Task; plan: UpdatePlan }[] = [];

      for (const taskId of input.taskIds) {
        const task = byId.get(taskId) as any;
        if (!task) {
          failed.push({ taskId, code: 'NOT_FOUND', reason: 'Task not found' });
          continue;
        }
        if (!canEditTask(user, task)) {
          failed.push({ taskId, code: 'FORBIDDEN', reason: 'You cannot edit this task' });
          continue;
        }
        if (task.week?.status === 'ARCHIVED') {
          failed.push({ taskId, code: 'WEEK_ARCHIVED', reason: weekClosedError().message });
          continue;
        }
        try {
          plans.push({ task, plan: await planUpdate(op, task, input.updates, targetWeek?.id) });
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          failed.push({ taskId, code: err.code, reason: err.message });
        }
      }
      if (failed.length) {
        throw new AppError(422, 'BULK_UPDATE_FAILED', 'No task was updated because some tasks failed validation', {
          successful: [],
          failed,
        });
      }

      const applied: { task: TaskRow; previous: Task; plan: UpdatePlan }[] = [];
      for (const { task, plan } of plans) {
        if (Object.keys(plan.changes).length === 0) continue;
        const updated = await tx.task.update({ where: { id: task.id }, data: plan.data, include: taskInclude });
        await logActivity(
          {
            workspaceId: user.workspaceId,
            userId: user.id,
            action: actionFor(plan.events),
            entityType: 'Task',
            entityId: task.id,
            changes: plan.changes,
            metadata: { bulk: true },
            ipAddress: ctx.ipAddress,
          },
          tx,
        );
        applied.push({ task: updated, previous: task, plan });
      }
      return applied;
    },
    { timeout: 20_000 },
  );

  for (const r of results) emitTaskUpdate(r.task, r.previous, r.plan.changes, r.plan.events, user.workspaceTimezone);
  await Promise.all(results.map((r) => notifyAssignee(user, r.task, r.previous.assignedToId)));
  return { successful: input.taskIds, failed: [] as never[], updatedCount: results.length };
}

// Soft delete; the task's files go with it (Gap 9) and are hard-deleted by the
// weekly cleanup job after 90 days.
export async function deleteTask(user: AuthUser, id: string, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const task = await prisma.$transaction(async (tx) => {
    const task = await findVisibleTask(tx, user, scope, id);
    if (!canDeleteTask(user, task)) throw forbidden('Only the creator, the area head or an administrator can delete this task');
    await assertWeekOpen(tx, task.weekId);
    const now = new Date();
    await tx.task.update({ where: { id }, data: { deletedAt: now } });
    const files = await tx.taskFile.updateMany({ where: { taskId: id, deletedAt: null }, data: { deletedAt: now } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.TASK_DELETED,
        entityType: 'Task',
        entityId: id,
        metadata: { title: task.title, filesArchived: files.count },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return task;
  });
  emitTo(taskRooms(task), 'task:deleted', { taskId: id });
}

// ─── Dependencies ───────────────────────────────────────────────────────────

export async function addDependency(user: AuthUser, taskId: string, dependsOnTaskId: string, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const task = await prisma.$transaction(async (tx) => {
    // Serialize dependency writes per workspace so two concurrent inserts can't
    // each pass the cycle check and together form a cycle.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deps:${user.workspaceId}`}))`;

    const task = await findVisibleTask(tx, user, scope, taskId);
    if (!canEditTask(user, task)) throw forbidden();
    await assertWeekOpen(tx, task.weekId);
    const prerequisite = await findVisibleTask(tx, user, scope, dependsOnTaskId).catch(() => {
      throw validationError('Prerequisite task not found', [{ field: 'dependsOnTaskId', message: 'invalid' }]);
    });

    const edges = await tx.taskDependency.findMany({
      where: { workspaceId: user.workspaceId, task: { deletedAt: null }, dependsOn: { deletedAt: null } },
      select: { taskId: true, dependsOnTaskId: true },
    });
    if (edges.some((e) => e.taskId === taskId && e.dependsOnTaskId === dependsOnTaskId)) return task;

    const cycle = findCycle(edges, taskId, dependsOnTaskId);
    if (cycle) {
      const titles = new Map(
        (await tx.task.findMany({ where: { id: { in: cycle } }, select: { id: true, title: true } })).map((t) => [t.id, t.title]),
      );
      const chain = cycle.map((id) => ({ id, title: titles.get(id) ?? '(tarea oculta)' }));
      throw new AppError(422, 'CIRCULAR_DEPENDENCY', `This would create a circular dependency: ${chain.map((c) => c.title).join(' → ')}`, {
        cycle: chain,
      });
    }

    await tx.taskDependency.create({ data: { workspaceId: user.workspaceId, taskId, dependsOnTaskId } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.TASK_DEPENDENCY_ADDED,
        entityType: 'Task',
        entityId: taskId,
        metadata: { dependsOnTaskId, dependsOnTitle: prerequisite.title },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return task;
  });
  emitTo(taskRooms(task), 'task:updated', { taskId, changes: { dependencies: { added: dependsOnTaskId } } });
}

export async function removeDependency(user: AuthUser, taskId: string, dependsOnTaskId: string, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const task = await prisma.$transaction(async (tx) => {
    const task = await findVisibleTask(tx, user, scope, taskId);
    if (!canEditTask(user, task)) throw forbidden();
    await assertWeekOpen(tx, task.weekId);
    const removed = await tx.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } });
    if (removed.count === 0) throw notFound('Dependency');
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.TASK_DEPENDENCY_REMOVED,
        entityType: 'Task',
        entityId: taskId,
        metadata: { dependsOnTaskId },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return task;
  });
  emitTo(taskRooms(task), 'task:updated', { taskId, changes: { dependencies: { removed: dependsOnTaskId } } });
}

// ─── Weekly cycle: observation & history ────────────────────────────────────

// The "Obs." of the task for its current week. Same people who update its %.
export async function setTaskObservation(user: AuthUser, id: string, observation: string | null, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const task = await findVisibleTask(prisma, user, scope, id);
  if (!canEditTask(user, task)) throw forbidden('You can only add notes to tasks assigned to you or that you manage');
  if (!task.weekId) throw validationError('This task is not in any week', [{ field: 'weekId', message: 'missing' }]);
  await assertWeekOpen(prisma, task.weekId);
  const weekId = task.weekId;

  const previous = await prisma.taskObservation.findUnique({ where: { taskId_weekId: { taskId: id, weekId } } });
  if ((previous?.observation ?? null) === observation) return { observation };
  await prisma.$transaction(async (tx) => {
    if (observation === null) await tx.taskObservation.deleteMany({ where: { taskId: id, weekId } });
    else {
      await tx.taskObservation.upsert({
        where: { taskId_weekId: { taskId: id, weekId } },
        update: { observation, createdById: user.id },
        create: { workspaceId: user.workspaceId, taskId: id, weekId, observation, createdById: user.id },
      });
    }
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.TASK_OBSERVATION_SET,
        entityType: 'Task',
        entityId: id,
        changes: { observation: { old: previous?.observation ?? null, new: observation } },
        metadata: { weekId },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  emitTo(taskRooms(task), 'task:observation', { taskId: id, weekId, observation });
  return { observation };
}

// Paged audit trail of one task (the detail panel shows only the latest 100).
export async function taskHistory(user: AuthUser, id: string, q: { page: number; limit: number }) {
  const scope = await departmentScope(user);
  await findVisibleTask(prisma, user, scope, id);
  const where = { workspaceId: user.workspaceId, entityType: 'Task', entityId: id };
  const [rows, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.activityLog.count({ where }),
  ]);
  return {
    data: rows.map((a) => ({
      id: a.id,
      action: a.action,
      changes: a.changes,
      metadata: a.metadata,
      timestamp: a.createdAt,
      user: a.user ? { id: a.user.id, name: a.user.displayName } : null,
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}
