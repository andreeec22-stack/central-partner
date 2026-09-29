import type { Prisma, Task } from '@prisma/client';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { canContribute, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { emitTo, taskRooms } from '../../lib/realtime';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import { notifySafely } from '../notifications/notify.service';
import { extractMentions, mentionableUsers, resolveMentions, type Mentionable } from './mentions';
import { findVisibleTask } from './task-access';

export const MAX_COMMENTS_PER_TASK = 1000;

export const commentInclude = {
  author: { select: { id: true, displayName: true, email: true } },
} satisfies Prisma.CommentInclude;

type CommentRow = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;

export function presentComment(c: CommentRow, people?: Map<string, { id: string; displayName: string; handle?: string }>) {
  return {
    id: c.id,
    taskId: c.taskId,
    userId: c.authorId,
    content: c.content,
    mentions: c.mentionedUserIds,
    mentionedUsers: c.mentionedUserIds.map((id) => people?.get(id)).filter((p) => !!p),
    editedAt: c.editedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    user: { id: c.author.id, name: c.author.displayName, email: c.author.email },
  };
}

const peopleIndex = (people: Mentionable[]) =>
  new Map(people.map((p) => [p.id, { id: p.id, displayName: p.displayName, handle: p.handle }]));

async function loadTask(user: AuthUser, taskId: string) {
  return findVisibleTask(prisma, user, await departmentScope(user), taskId);
}

async function findComment(task: Task, commentId: string) {
  const comment = await prisma.comment.findFirst({
    where: { id: commentId, taskId: task.id, workspaceId: task.workspaceId, deletedAt: null },
    include: commentInclude,
  });
  if (!comment) throw notFound('Comment');
  return comment;
}

const excerpt = (text: string) => (text.length > 140 ? `${text.slice(0, 137)}…` : text);

export async function listComments(user: AuthUser, taskId: string) {
  const task = await loadTask(user, taskId);
  const [rows, people] = await Promise.all([
    prisma.comment.findMany({
      where: { taskId: task.id, deletedAt: null },
      include: commentInclude,
      orderBy: { createdAt: 'desc' },
    }),
    mentionableUsers(prisma, task.workspaceId, task.departmentId),
  ]);
  const index = peopleIndex(people);
  return { data: rows.map((c) => presentComment(c, index)) };
}

// The @mention autocomplete list: exactly the people a mention can reach.
export async function listMentionable(user: AuthUser, taskId: string) {
  const task = await loadTask(user, taskId);
  const people = await mentionableUsers(prisma, task.workspaceId, task.departmentId);
  return { data: people.map((p) => ({ id: p.id, displayName: p.displayName, handle: p.handle, role: p.role })) };
}

export async function createComment(user: AuthUser, taskId: string, content: string, ctx: ClientContext) {
  const task = await loadTask(user, taskId);
  if (!canContribute(user, task)) throw forbidden('You cannot comment on this task');

  const people = await mentionableUsers(prisma, task.workspaceId, task.departmentId);
  const mentioned = resolveMentions(extractMentions(content), people).filter((id) => id !== user.id);

  const { comment, previousAuthors } = await prisma.$transaction(async (tx) => {
    // Serialize comment writes per task so the 1000-comment cap holds under concurrency.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comments:${task.id}`}))`;
    const count = await tx.comment.count({ where: { taskId: task.id, deletedAt: null } });
    if (count >= MAX_COMMENTS_PER_TASK) {
      throw conflict(`A task can have at most ${MAX_COMMENTS_PER_TASK} comments`, 'COMMENT_LIMIT_REACHED');
    }
    const previousAuthors = await tx.comment.findMany({
      where: { taskId: task.id, deletedAt: null, authorId: { not: user.id } },
      distinct: ['authorId'],
      select: { authorId: true },
    });
    const comment = await tx.comment.create({
      data: { workspaceId: task.workspaceId, taskId: task.id, authorId: user.id, content, mentionedUserIds: mentioned },
      include: commentInclude,
    });
    await tx.task.update({
      where: { id: task.id },
      data: {
        totalCommentsCount: { increment: 1 },
        totalMentionsCount: { increment: mentioned.length },
        ...(task.collaborationParticipantIds.includes(user.id) ? {} : { collaborationParticipantIds: { push: user.id } }),
      },
    });
    await logActivity(
      {
        workspaceId: task.workspaceId,
        userId: user.id,
        action: ActivityAction.COMMENT_ADDED,
        entityType: 'Task',
        entityId: task.id,
        metadata: { commentId: comment.id, excerpt: excerpt(content), mentions: mentioned },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return { comment, previousAuthors: previousAuthors.map((a) => a.authorId) };
  });

  const presented = presentComment(comment, peopleIndex(people));
  emitTo(taskRooms(task), 'comment:created', { taskId: task.id, comment: presented });

  const actor = { id: user.id, displayName: user.displayName };
  const visible = new Set(people.map((p) => p.id));
  await notifySafely({
    workspaceId: task.workspaceId,
    recipientIds: mentioned,
    type: 'MENTIONED',
    actor,
    task,
    title: `${user.displayName} te mencionó en "${task.title}"`,
    body: excerpt(content),
  });
  // Earlier commenters hear about the reply — unless they were just mentioned
  // (one notification is enough) or can no longer see the task.
  await notifySafely({
    workspaceId: task.workspaceId,
    recipientIds: previousAuthors.filter((id) => !mentioned.includes(id) && visible.has(id)),
    type: 'COMMENT_REPLY',
    actor,
    task,
    title: `${user.displayName} comentó en "${task.title}"`,
    body: excerpt(content),
  });

  return { comment: presented };
}

// Author or ADMIN. Only newly added mentions are notified.
export async function updateComment(user: AuthUser, taskId: string, commentId: string, content: string, ctx: ClientContext) {
  const task = await loadTask(user, taskId);
  const current = await findComment(task, commentId);
  if (current.authorId !== user.id && user.role !== 'ADMIN') throw forbidden('Only the author or an administrator can edit this comment');

  const people = await mentionableUsers(prisma, task.workspaceId, task.departmentId);
  const mentioned = resolveMentions(extractMentions(content), people).filter((id) => id !== current.authorId);
  const added = mentioned.filter((id) => !current.mentionedUserIds.includes(id));

  const comment = await prisma.$transaction(async (tx) => {
    const updated = await tx.comment.update({
      where: { id: current.id },
      data: { content, mentionedUserIds: mentioned, editedAt: new Date() },
      include: commentInclude,
    });
    if (added.length) await tx.task.update({ where: { id: task.id }, data: { totalMentionsCount: { increment: added.length } } });
    await logActivity(
      {
        workspaceId: task.workspaceId,
        userId: user.id,
        action: ActivityAction.COMMENT_EDITED,
        entityType: 'Task',
        entityId: task.id,
        changes: { content: { old: current.content, new: content } },
        metadata: { commentId: current.id },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return updated;
  });

  const presented = presentComment(comment, peopleIndex(people));
  emitTo(taskRooms(task), 'comment:updated', { taskId: task.id, comment: presented });
  await notifySafely({
    workspaceId: task.workspaceId,
    recipientIds: added,
    type: 'MENTIONED',
    actor: { id: user.id, displayName: user.displayName },
    task,
    title: `${user.displayName} te mencionó en "${task.title}"`,
    body: excerpt(content),
  });
  return { comment: presented };
}

// Soft delete: the text stays in the DB and the audit log.
export async function deleteComment(user: AuthUser, taskId: string, commentId: string, ctx: ClientContext) {
  const task = await loadTask(user, taskId);
  const current = await findComment(task, commentId);
  if (current.authorId !== user.id && user.role !== 'ADMIN') throw forbidden('Only the author or an administrator can delete this comment');

  await prisma.$transaction(async (tx) => {
    await tx.comment.update({ where: { id: current.id }, data: { deletedAt: new Date() } });
    await tx.task.update({ where: { id: task.id }, data: { totalCommentsCount: { decrement: 1 } } });
    await logActivity(
      {
        workspaceId: task.workspaceId,
        userId: user.id,
        action: ActivityAction.COMMENT_DELETED,
        entityType: 'Task',
        entityId: task.id,
        metadata: { commentId: current.id, authorId: current.authorId, excerpt: excerpt(current.content) },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  emitTo(taskRooms(task), 'comment:deleted', { taskId: task.id, commentId: current.id });
}
