import type { Prisma, Task } from '@prisma/client';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors';
import {
  canCreateTaskIn,
  canDeleteTask,
  canEditTask,
  canSeeDepartment,
  departmentFilter,
  departmentScope,
  type DepartmentScope,
} from '../../lib/permissions';
import { prisma, type Tx } from '../../lib/prisma';
import { emitTo, emitToExcept, taskRooms } from '../../lib/realtime';
import { semaphoreFor } from '../../lib/semaphore';
import { weekRange } from '../../lib/time';
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
  _count: {
    select: {
      subTasks: { where: { deletedAt: null } },
      comments: { where: { deletedAt: null } },
      files: { where: { deletedAt: null } },
    },
  },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function presentTask(t: TaskRow) {
  const { _count, deletedAt: _deleted, collaborationParticipantIds: _participants, ...rest } = t;
  return { ...rest, counts: _count };
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

async function findVisibleTask(db: Tx, user: AuthUser, scope: DepartmentScope, id: string): Promise<Task> {
  const task = await db.task.findFirst({
    where: { id, workspaceId: user.workspaceId, deletedAt: null, departmentId: departmentFilter(scope) },
  });
  // 404 rather than 403: tasks outside your scope don't exist for you.
  if (!task) throw notFound('Task');
  return task;
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
  const parentOf = new Map(links.map((l) => [l.id, l.parentTaskId]));
  if (createsParentCycle(taskId, parentId, (id) => parentOf.get(id))) {
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

async function planUpdate(ctx: OpContext, task: Task, patch: UpdateTaskInput): Promise<UpdatePlan> {
  const { user } = ctx;
  const data: Prisma.TaskUncheckedUpdateInput = {};

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

function emitTaskUpdate(task: TaskRow, previous: Task, changes: FieldChanges, events: TaskStateEvents) {
  const audience = taskRooms(task);
  const formerAudience = taskRooms(previous).filter((r) => !audience.includes(r));
  if (formerAudience.length) {
    emitToExcept(formerAudience, audience, 'task:updated', { taskId: task.id, removed: true });
  }
  emitTo(audience, 'task:updated', { taskId: task.id, changes, task: presentTask(task), updatedAt: task.updatedAt });
  if (events.progressChanged) {
    emitTo(audience, 'task:progress', { taskId: task.id, progress: task.progress, semaphore: task.semaphore });
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
  return { data: rows.map(presentTask), total, page, limit, filters };
}

export async function getTaskDetail(user: AuthUser, id: string) {
  const scope = await departmentScope(user);
  await findVisibleTask(prisma, user, scope, id);

  const [task, comments, files, subTasks, dependencies, dependents, activity] = await Promise.all([
    prisma.task.findUniqueOrThrow({ where: { id }, include: taskInclude }),
    prisma.comment.findMany({
      where: { taskId: id, deletedAt: null },
      include: { author: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.taskFile.findMany({
      where: { taskId: id, deletedAt: null },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedById: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.findMany({
      where: { parentTaskId: id, deletedAt: null },
      select: { id: true, title: true, status: true, progress: true, semaphore: true, assignedToId: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.taskDependency.findMany({
      where: { taskId: id, dependsOn: { deletedAt: null } },
      select: { dependsOn: { select: { id: true, title: true, status: true, semaphore: true } } },
    }),
    prisma.taskDependency.findMany({
      where: { dependsOnTaskId: id, task: { deletedAt: null } },
      select: { task: { select: { id: true, title: true, status: true, semaphore: true } } },
    }),
    prisma.activityLog.findMany({
      where: { workspaceId: user.workspaceId, entityType: 'Task', entityId: id },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return {
    task: presentTask(task),
    blockReason: task.blockReason,
    blockedSince: task.blockedSince,
    comments,
    files,
    subTasks,
    dependencies: dependencies.map((d) => d.dependsOn),
    dependents: dependents.map((d) => d.task),
    activity,
  };
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export async function createTask(user: AuthUser, input: CreateTaskInput, ctx: ClientContext) {
  const departmentId = input.departmentId ?? user.departmentId;
  if (!departmentId) {
    throw validationError('Choose a department for the task', [{ field: 'departmentId', message: 'required' }]);
  }
  if (!canCreateTaskIn(user, departmentId)) throw forbidden('You can only create tasks in your own department');
  // Excel habit: people write their own tasks, so a USER's task defaults to themself.
  const assignedToId = input.assignedTo !== undefined ? input.assignedTo : user.role === 'USER' ? user.id : null;
  const scope = await departmentScope(user);

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
        semaphore: semaphoreFor(0),
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

  const payload = presentTask(task);
  emitTo(taskRooms(task), 'task:created', {
    taskId: task.id,
    title: task.title,
    departmentId: task.departmentId,
    assignedTo: task.assignedToId,
    priority: task.priority,
    sourceType: task.sourceType,
    task: payload,
  });
  return { task: payload };
}

export async function updateTask(user: AuthUser, id: string, patch: UpdateTaskInput, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const result = await prisma.$transaction(async (tx) => {
    const op: OpContext = { tx, user, scope, now: new Date(), memo: new Map() };
    const task = await findVisibleTask(tx, user, scope, id);
    if (!canEditTask(user, task)) throw forbidden('You can only edit tasks assigned to you or that you created');

    const plan = await planUpdate(op, task, patch);
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
    emitTaskUpdate(result.task, result.previous, result.plan.changes, result.plan.events);
  }
  return { task: presentTask(result.task) };
}

// Gap 13: all-or-nothing. Every task is validated first; if any fails, nothing
// is written and the caller gets the per-task reasons.
export async function bulkUpdateTasks(user: AuthUser, input: BulkUpdateInput, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const results = await prisma.$transaction(
    async (tx) => {
      const op: OpContext = { tx, user, scope, now: new Date(), memo: new Map() };
      const tasks = await tx.task.findMany({
        where: { id: { in: input.taskIds }, workspaceId: user.workspaceId, deletedAt: null, departmentId: departmentFilter(scope) },
      });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const failed: { taskId: string; code: string; reason: string }[] = [];
      const plans: { task: Task; plan: UpdatePlan }[] = [];

      for (const taskId of input.taskIds) {
        const task = byId.get(taskId);
        if (!task) {
          failed.push({ taskId, code: 'NOT_FOUND', reason: 'Task not found' });
          continue;
        }
        if (!canEditTask(user, task)) {
          failed.push({ taskId, code: 'FORBIDDEN', reason: 'You cannot edit this task' });
          continue;
        }
        try {
          plans.push({ task, plan: await planUpdate(op, task, input.updates) });
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

  for (const r of results) emitTaskUpdate(r.task, r.previous, r.plan.changes, r.plan.events);
  return { successful: input.taskIds, failed: [] as never[], updatedCount: results.length };
}

// Soft delete; the task's files go with it (Gap 9) and are hard-deleted by the
// weekly cleanup job after 90 days.
export async function deleteTask(user: AuthUser, id: string, ctx: ClientContext) {
  const scope = await departmentScope(user);
  const task = await prisma.$transaction(async (tx) => {
    const task = await findVisibleTask(tx, user, scope, id);
    if (!canDeleteTask(user, task)) throw forbidden('Only the creator, the area head or an administrator can delete this task');
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
