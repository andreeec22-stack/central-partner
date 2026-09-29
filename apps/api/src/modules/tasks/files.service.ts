import { randomUUID } from 'node:crypto';
import type { Prisma, Task } from '@prisma/client';
import { env } from '../../config/env';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { safeFilename } from '../../lib/file-types';
import { canContribute, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { emitTo, taskRooms } from '../../lib/realtime';
import { getStorage } from '../../lib/storage';
import type { Upload } from '../../lib/upload';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { findVisibleTask } from './task-access';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_TASK = 10;

export const fileInclude = { uploadedBy: { select: { id: true, displayName: true } } } satisfies Prisma.TaskFileInclude;
type FileRow = Prisma.TaskFileGetPayload<{ include: typeof fileInclude }>;

const downloadUrl = (f: Pick<FileRow, 'storageKey' | 'filename' | 'mimeType'>) =>
  getStorage().signedUrl(f.storageKey, { filename: f.filename, contentType: f.mimeType, disposition: 'attachment' });

export async function presentFile(f: FileRow) {
  return {
    id: f.id,
    taskId: f.taskId,
    uploadedBy: f.uploadedById,
    filename: f.storageKey.split('/').pop()!,
    originalFilename: f.filename,
    fileUrl: await downloadUrl(f),
    urlExpiresAt: new Date(Date.now() + env.FILE_URL_TTL_SECONDS * 1000),
    fileSize: f.sizeBytes,
    mimeType: f.mimeType,
    uploadedAt: f.createdAt,
    user: { id: f.uploadedBy.id, name: f.uploadedBy.displayName },
  };
}

async function loadTask(user: AuthUser, taskId: string) {
  return findVisibleTask(prisma, user, await departmentScope(user), taskId);
}

async function findFile(task: Task, fileId: string) {
  const file = await prisma.taskFile.findFirst({
    where: { id: fileId, taskId: task.id, workspaceId: task.workspaceId, deletedAt: null },
    include: fileInclude,
  });
  if (!file) throw notFound('File');
  return file;
}

export async function listFiles(user: AuthUser, taskId: string) {
  const task = await loadTask(user, taskId);
  const rows = await prisma.taskFile.findMany({
    where: { taskId: task.id, deletedAt: null },
    include: fileInclude,
    orderBy: { createdAt: 'desc' },
  });
  return { data: await Promise.all(rows.map(presentFile)) };
}

export async function uploadFile(user: AuthUser, taskId: string, upload: Upload, ctx: ClientContext) {
  const task = await loadTask(user, taskId);
  if (!canContribute(user, task)) throw forbidden('You cannot add files to this task');

  // Cheap early check; the authoritative one runs under the lock below.
  const existing = await prisma.taskFile.count({ where: { taskId: task.id, deletedAt: null } });
  if (existing >= MAX_FILES_PER_TASK) throw conflict(`A task can have at most ${MAX_FILES_PER_TASK} files`, 'FILE_LIMIT_REACHED');

  const storageKey = `tasks/${task.id}/${randomUUID()}-${safeFilename(upload.name)}`;
  await getStorage().put(storageKey, upload.bytes, upload.mimeType);

  const file = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`files:${task.id}`}))`;
    const count = await tx.taskFile.count({ where: { taskId: task.id, deletedAt: null } });
    // The object already uploaded stays orphaned; the storage cleanup job sweeps it.
    if (count >= MAX_FILES_PER_TASK) throw conflict(`A task can have at most ${MAX_FILES_PER_TASK} files`, 'FILE_LIMIT_REACHED');
    const file = await tx.taskFile.create({
      data: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        uploadedById: user.id,
        filename: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.size,
        storageKey,
      },
      include: fileInclude,
    });
    await logActivity(
      {
        workspaceId: task.workspaceId,
        userId: user.id,
        action: ActivityAction.FILE_UPLOADED,
        entityType: 'Task',
        entityId: task.id,
        metadata: { fileId: file.id, filename: file.filename, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return file;
  });

  const presented = await presentFile(file);
  // No URL in the broadcast: each client asks for its own when downloading.
  const { fileUrl: _url, urlExpiresAt: _exp, ...broadcast } = presented;
  emitTo(taskRooms(task), 'file:uploaded', { taskId: task.id, file: broadcast });
  return { file: presented };
}

// Anyone who can see the task can download its files.
export async function fileDownloadUrl(user: AuthUser, taskId: string, fileId: string) {
  const task = await loadTask(user, taskId);
  const file = await findFile(task, fileId);
  return { url: await downloadUrl(file), expiresAt: new Date(Date.now() + env.FILE_URL_TTL_SECONDS * 1000), filename: file.filename };
}

// Uploader or ADMIN. Soft delete only: the stored object is kept for the audit trail.
export async function deleteFile(user: AuthUser, taskId: string, fileId: string, ctx: ClientContext) {
  const task = await loadTask(user, taskId);
  const file = await findFile(task, fileId);
  if (file.uploadedById !== user.id && user.role !== 'ADMIN') {
    throw forbidden('Only the uploader or an administrator can delete this file');
  }
  await prisma.$transaction(async (tx) => {
    await tx.taskFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
    await logActivity(
      {
        workspaceId: task.workspaceId,
        userId: user.id,
        action: ActivityAction.FILE_DELETED,
        entityType: 'Task',
        entityId: task.id,
        metadata: { fileId: file.id, filename: file.filename },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  emitTo(taskRooms(task), 'file:deleted', { taskId: task.id, fileId: file.id });
}
