import { randomUUID } from 'node:crypto';
import type { ExcelImport, Prisma } from '@prisma/client';
import { AppError, conflict, notFound } from '../../lib/errors';
import { safeFilename } from '../../lib/file-types';
import { logger } from '../../lib/logger';
import { toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { semaphoreFor } from '../../lib/semaphore';
import { getStorage } from '../../lib/storage';
import type { Upload } from '../../lib/upload';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { notifySafely } from '../notifications/notify.service';
import { detectTasks, type DetectedTask, type DetectionResult } from './detection';
import type { ConfirmImportInput } from './excel-imports.schemas';
import { readSheet } from './xlsx';

// Excel import in two steps: upload → the server detects tasks and the import
// waits in PENDING for review → an ADMIN confirms (possibly after correcting
// the suggestions) and the tasks are created. Parsing ≤1000 rows takes
// milliseconds, so it runs inside the upload request; the status still moves
// PROCESSING → PENDING (or FAILED) and clients are told over the socket.

export const MAX_EXCEL_BYTES = 10 * 1024 * 1024;
export const MAX_OPEN_IMPORTS = 5;

function presentImport(i: ExcelImport) {
  return {
    id: i.id,
    workspaceId: i.workspaceId,
    uploadedBy: i.uploadedById,
    filename: i.filename,
    uploadedAt: i.uploadedAt,
    status: i.status,
    errorMessage: i.errorMessage,
    totalRows: i.totalRows,
    detectedCount: (i.detectedTasks as unknown[] | null)?.length ?? 0,
    mappedCount: i.mappedTasksCount,
    failureCount: i.unmappedRowsCount,
    createdCount: i.createdCount,
    skippedCount: i.skippedCount,
    confirmedAt: i.confirmedAt,
  };
}

async function referenceData(workspaceId: string) {
  const [departments, users] = await Promise.all([
    prisma.department.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, name: true, headId: true } }),
    prisma.user.findMany({
      where: { workspaceId, deletedAt: null, role: { not: 'VIEWER' } },
      select: { id: true, displayName: true, email: true, departmentId: true, role: true },
    }),
  ]);
  return { departments, users };
}

export async function uploadImport(user: AuthUser, upload: Upload, ctx: ClientContext) {
  const open = await prisma.excelImport.count({
    where: { workspaceId: user.workspaceId, status: { in: ['PENDING', 'PROCESSING'] } },
  });
  if (open >= MAX_OPEN_IMPORTS) {
    throw conflict(
      `There are already ${MAX_OPEN_IMPORTS} imports waiting for review. Confirm or discard one first.`,
      'TOO_MANY_OPEN_IMPORTS',
    );
  }

  const fileKey = `imports/${user.workspaceId}/${randomUUID()}-${safeFilename(upload.name)}`;
  await getStorage().put(fileKey, upload.bytes, upload.mimeType);
  let record = await prisma.excelImport.create({
    data: {
      workspaceId: user.workspaceId,
      uploadedById: user.id,
      filename: upload.name,
      fileKey,
      rawData: [],
      detectedTasks: [],
      status: 'PROCESSING',
    },
  });

  let result: DetectionResult;
  try {
    const rows = await readSheet(upload.bytes);
    const { departments, users } = await referenceData(user.workspaceId);
    result = detectTasks(rows, departments, users);
    record = await prisma.excelImport.update({
      where: { id: record.id },
      data: {
        status: 'PENDING',
        rawData: rows as unknown as Prisma.InputJsonValue,
        detectedTasks: result.detectedTasks as unknown as Prisma.InputJsonValue,
        mappingLog: { ...result.mappingLog, unmappedRows: result.unmappedRows } as unknown as Prisma.InputJsonValue,
        totalRows: result.totalRowsCount,
        mappedTasksCount: result.detectedTasks.length,
        unmappedRowsCount: result.unmappedRows.length,
      },
    });
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'The file could not be processed';
    if (!(error instanceof AppError)) logger.error('excel import failed', { error, importId: record.id });
    await prisma.excelImport.update({ where: { id: record.id }, data: { status: 'FAILED', errorMessage: message } });
    emitTo([rooms.admins(user.workspaceId)], 'excel:processing_complete', { importId: record.id, status: 'FAILED' });
    throw error;
  }

  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.EXCEL_IMPORT_UPLOADED,
    entityType: 'ExcelImport',
    entityId: record.id,
    metadata: { filename: upload.name, totalRows: result.totalRowsCount, detected: result.detectedTasks.length },
    ipAddress: ctx.ipAddress,
  });
  emitTo([rooms.admins(user.workspaceId)], 'excel:processing_complete', {
    importId: record.id,
    status: record.status,
    detectedCount: result.detectedTasks.length,
  });

  return {
    importId: record.id,
    status: record.status,
    detectedTasks: result.detectedTasks,
    unmappedRowsCount: result.unmappedRows.length,
    unmappedRows: result.unmappedRows,
    totalRowsCount: result.totalRowsCount,
  };
}

async function findImport(user: AuthUser, id: string) {
  const record = await prisma.excelImport.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (!record) throw notFound('Import');
  return record;
}

export async function getImport(user: AuthUser, id: string) {
  const record = await findImport(user, id);
  return {
    import: presentImport(record),
    detectedTasks: record.detectedTasks as unknown as DetectedTask[],
    mappingLog: record.mappingLog,
  };
}

export async function listImports(user: AuthUser, q: { page: number; limit: number }) {
  const where = { workspaceId: user.workspaceId };
  const [rows, total] = await Promise.all([
    prisma.excelImport.findMany({ where, orderBy: { uploadedAt: 'desc' }, ...toSkipTake(q) }),
    prisma.excelImport.count({ where }),
  ]);
  return { data: rows.map(presentImport), total, page: q.page, limit: q.limit };
}

// A PENDING import can be dropped without creating anything.
export async function discardImport(user: AuthUser, id: string) {
  const record = await findImport(user, id);
  if (record.status !== 'PENDING') throw conflict('Only imports waiting for review can be discarded', 'IMPORT_NOT_PENDING');
  await prisma.excelImport.update({ where: { id }, data: { status: 'FAILED', errorMessage: 'Discarded' } });
}

const titleKey = (departmentId: string, title: string) => `${departmentId}:${title.trim().toLowerCase()}`;

export async function confirmImport(user: AuthUser, id: string, input: ConfirmImportInput, ctx: ClientContext) {
  const { departments, users } = await referenceData(user.workspaceId);
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const validAssignee = (userId: string, departmentId: string) => {
    const u = userById.get(userId);
    return !!u && (u.role === 'ADMIN' || u.departmentId === departmentId);
  };

  const outcome = await prisma.$transaction(
    async (tx) => {
      // One confirmation per import, even if the button is double-clicked.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`excel-import:${id}`}))`;
      const record = await tx.excelImport.findFirst({ where: { id, workspaceId: user.workspaceId } });
      if (!record) throw notFound('Import');
      if (record.status !== 'PENDING') throw conflict('This import was already confirmed or discarded', 'IMPORT_NOT_PENDING');
      const knownRows = new Set((record.detectedTasks as unknown as DetectedTask[]).map((t) => t.rowIndex));

      const existing = await tx.task.findMany({
        where: { workspaceId: user.workspaceId, deletedAt: null, departmentId: { in: [...new Set(input.taskMappings.map((m) => m.departmentId))] } },
        select: { departmentId: true, title: true },
      });
      const taken = new Set(existing.map((t) => titleKey(t.departmentId, t.title)));

      const skipped: { rowIndex: number; reason: string }[] = [];
      const toCreate: Prisma.TaskCreateManyInput[] = [];
      const now = new Date();
      for (const m of input.taskMappings) {
        if (!knownRows.has(m.rowIndex)) {
          skipped.push({ rowIndex: m.rowIndex, reason: 'Row not found in this import' });
          continue;
        }
        const dept = deptById.get(m.departmentId);
        if (!dept) {
          skipped.push({ rowIndex: m.rowIndex, reason: 'No department found' });
          continue;
        }
        const key = titleKey(dept.id, m.title);
        if (taken.has(key)) {
          skipped.push({ rowIndex: m.rowIndex, reason: 'Duplicate task in department' });
          continue;
        }
        let assignedToId = m.assignedToId ?? null;
        if (assignedToId && !validAssignee(assignedToId, dept.id)) {
          skipped.push({ rowIndex: m.rowIndex, reason: "Assignee is not an active member of the task's department" });
          continue;
        }
        // No assignee given: the department head takes it.
        if (m.assignedToId === undefined && dept.headId && validAssignee(dept.headId, dept.id)) assignedToId = dept.headId;

        const status = m.status ?? 'TODO';
        const done = status === 'DONE';
        taken.add(key);
        toCreate.push({
          workspaceId: user.workspaceId,
          departmentId: dept.id,
          assignedToId,
          createdById: user.id,
          title: m.title,
          description: m.description ?? null,
          priority: m.priority ?? 'MEDIUM',
          status,
          progress: done ? 100 : 0,
          semaphore: semaphoreFor(done ? 100 : 0),
          dueDate: m.dueDate ?? null,
          kpiTarget: m.kpiTarget ?? null,
          sourceType: 'EXCEL_IMPORT',
          excelImportId: id,
          actualStartDate: status === 'TODO' ? null : now,
          actualCompletionDate: done ? now : null,
          priorityAtCompletion: done ? (m.priority ?? 'MEDIUM') : null,
          collaborationParticipantIds: [user.id],
        });
      }

      const created = toCreate.length
        ? await tx.task.createManyAndReturn({
            data: toCreate,
            select: { id: true, title: true, departmentId: true, assignedToId: true, workspaceId: true, priority: true },
          })
        : [];
      if (created.length) {
        await tx.activityLog.createMany({
          data: created.map((t) => ({
            workspaceId: user.workspaceId,
            userId: user.id,
            action: ActivityAction.TASK_CREATED,
            entityType: 'Task',
            entityId: t.id,
            changes: {
              title: { old: null, new: t.title },
              departmentId: { old: null, new: t.departmentId },
              assignedToId: { old: null, new: t.assignedToId },
              priority: { old: null, new: t.priority },
            },
            metadata: { source: 'EXCEL_IMPORT', excelImportId: id },
            ipAddress: ctx.ipAddress,
          })),
        });
      }
      await tx.excelImport.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          createdCount: created.length,
          skippedCount: skipped.length,
          confirmedAt: now,
          confirmedById: user.id,
          mappingLog: { ...((record.mappingLog as object | null) ?? {}), skipped } as Prisma.InputJsonValue,
        },
      });
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.EXCEL_IMPORT_CONFIRMED,
          entityType: 'ExcelImport',
          entityId: id,
          metadata: { createdCount: created.length, skippedCount: skipped.length },
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
      return { created, skipped };
    },
    { timeout: 30_000 },
  );

  // One broadcast per department so every audience refetches once.
  const byDept = new Map<string, number>();
  for (const t of outcome.created) byDept.set(t.departmentId, (byDept.get(t.departmentId) ?? 0) + 1);
  for (const [departmentId, count] of byDept) {
    emitTo([rooms.admins(user.workspaceId), rooms.department(departmentId)], 'tasks:imported', { importId: id, departmentId, count });
  }

  // One notification per assignee, not one per task.
  const byAssignee = new Map<string, typeof outcome.created>();
  for (const t of outcome.created) {
    if (t.assignedToId) byAssignee.set(t.assignedToId, [...(byAssignee.get(t.assignedToId) ?? []), t]);
  }
  for (const [assigneeId, tasks] of byAssignee) {
    await notifySafely({
      workspaceId: user.workspaceId,
      recipientIds: [assigneeId],
      type: 'TASK_ASSIGNED',
      actor: { id: user.id, displayName: user.displayName },
      task: tasks[0]!,
      title:
        tasks.length === 1
          ? `${user.displayName} te asignó "${tasks[0]!.title}"`
          : `${user.displayName} te asignó ${tasks.length} tareas importadas desde Excel`,
    });
  }

  return {
    createdCount: outcome.created.length,
    skippedCount: outcome.skipped.length,
    skippedDetails: outcome.skipped,
  };
}
