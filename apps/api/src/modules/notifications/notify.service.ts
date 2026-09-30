import type { NotificationType } from '@prisma/client';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { sendWhatsApp, type WhatsAppType } from './whatsapp.service';

// Fan-out for task and week events: an in-app notification (badge +
// dropdown), pushed over the socket, plus a WhatsApp message for the task
// events the recipient opted in to. Call it AFTER the triggering transaction commits.

const WHATSAPP_TYPES: readonly NotificationType[] = ['MENTIONED', 'TASK_ASSIGNED', 'COMMENT_REPLY'] satisfies WhatsAppType[];

export interface NotifyInput {
  workspaceId: string;
  recipientIds: string[];
  type: NotificationType;
  // null = the system (e.g. the weekly scheduler).
  actor: { id: string; displayName: string } | null;
  task?: { id: string; title: string } | null;
  title: string;
  body?: string | null;
}

// WhatsApp sends run in the background; tests await them through this.
const inFlight = new Set<Promise<unknown>>();

export async function flushNotifications() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

export async function notify(input: NotifyInput) {
  const recipients = [...new Set(input.recipientIds)].filter((id) => id !== input.actor?.id);
  if (!recipients.length) return;

  const created = await prisma.notification.createManyAndReturn({
    data: recipients.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      type: input.type,
      title: input.title.slice(0, 255),
      body: input.body?.slice(0, 1000) ?? null,
      taskId: input.task?.id ?? null,
      actorId: input.actor?.id ?? null,
    })),
  });

  for (const n of created) {
    emitTo([rooms.user(n.userId)], 'notification:created', {
      notification: { ...n, fromUser: input.actor, taskTitle: input.task?.title ?? null },
    });
    if (!input.task || !WHATSAPP_TYPES.includes(input.type)) continue;
    const delivery = sendWhatsApp({ userId: n.userId, type: input.type as WhatsAppType, task: input.task })
      .catch((error) => logger.error('whatsapp delivery crashed', { error, userId: n.userId }))
      .finally(() => inFlight.delete(delivery));
    inFlight.add(delivery);
  }
}

// Never let a notification problem undo the action the user just completed.
export function notifySafely(input: NotifyInput) {
  return notify(input).catch((error) => logger.error('notify failed', { error, type: input.type, taskId: input.task?.id }));
}
