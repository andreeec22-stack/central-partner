import type { NotificationType, WhatsAppDeliveryStatus } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { isQuietTime } from '../../lib/quiet-hours';
import { getRedis } from '../../lib/redis';

// WhatsApp is a best-effort side channel: it never fails the request that
// triggered it, and every attempt (sent, skipped or failed) is logged.

export const WHATSAPP_RATE_LIMIT_MS = 5 * 60 * 1000;

export type WhatsAppType = Extract<NotificationType, 'MENTIONED' | 'TASK_ASSIGNED' | 'COMMENT_REPLY'>;

export interface WhatsAppMessage {
  userId: string;
  type: WhatsAppType;
  task: { id: string; title: string };
}

// Replaceable transport so tests can capture messages.
export interface WhatsAppTransport {
  send(to: string, body: string): Promise<{ id: string }>;
}

const twilioTransport: WhatsAppTransport = {
  async send(to, body) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const from = env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, '');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}`, Body: body }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? 'request failed'}`);
    return { id: json.sid ?? '' };
  },
};

const consoleTransport: WhatsAppTransport = {
  async send(to, body) {
    logger.info('whatsapp (dev, not sent)', { to, body });
    return { id: 'dev' };
  },
};

let transport: WhatsAppTransport | null = null;
const getTransport = () => (transport ??= env.TWILIO_ACCOUNT_SID ? twilioTransport : consoleTransport);

export function setWhatsAppTransport(next: WhatsAppTransport | null) {
  transport = next;
}

export function composeMessage(type: WhatsAppType, task: { id: string; title: string }): string {
  const link = `${env.APP_URL}/task/${task.id}`;
  const title = task.title.length > 120 ? `${task.title.slice(0, 117)}…` : task.title;
  switch (type) {
    case 'MENTIONED':
      return `Te mencionaron en: "${title}"\nLink: ${link}`;
    case 'TASK_ASSIGNED':
      return `Nueva tarea asignada: "${title}"\nLink: ${link}`;
    case 'COMMENT_REPLY':
      return `Respuesta en tarea: "${title}"\nLink: ${link}`;
  }
}

// At most one message per user and task every 5 minutes. With Redis the slot
// is claimed atomically (SET NX), so two near-simultaneous events on different
// instances can't both send; without it the log table is the (racy) fallback.
const slotKey = (userId: string, taskId: string) => `wa:slot:${userId}:${taskId}`;

async function claimSlot(userId: string, taskId: string, now: Date): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      return (await redis.set(slotKey(userId, taskId), '1', 'PX', WHATSAPP_RATE_LIMIT_MS, 'NX')) === 'OK';
    } catch (error) {
      logger.warn('whatsapp rate-limit via redis failed, using the log', { error });
    }
  }
  const recent = await prisma.whatsAppNotificationLog.findFirst({
    where: { userId, taskId, status: 'SENT', createdAt: { gt: new Date(now.getTime() - WHATSAPP_RATE_LIMIT_MS) } },
    select: { id: true },
  });
  return !recent;
}

// A failed send shouldn't block the next attempt.
async function releaseSlot(userId: string, taskId: string) {
  await getRedis()?.del(slotKey(userId, taskId)).catch(() => undefined);
}

export async function sendWhatsApp(msg: WhatsAppMessage, now = new Date()): Promise<WhatsAppDeliveryStatus | null> {
  const user = await prisma.user.findUnique({
    where: { id: msg.userId },
    select: { id: true, workspaceId: true, phoneNumber: true, timezone: true, deletedAt: true, notificationPrefs: true },
  });
  const prefs = user?.notificationPrefs;
  if (!user || user.deletedAt || !user.phoneNumber || !prefs?.enableWhatsApp) return null;
  // Per-event toggles: a missing key means enabled.
  const events = (prefs.whatsAppEvents ?? {}) as Record<string, boolean>;
  if (events[msg.type] === false) return null;

  const log = (status: WhatsAppDeliveryStatus, extra: { reason?: string; providerId?: string } = {}) =>
    prisma.whatsAppNotificationLog
      .create({
        data: {
          workspaceId: user.workspaceId,
          userId: user.id,
          taskId: msg.task.id,
          phoneNumber: user.phoneNumber!,
          type: msg.type,
          status,
          reason: extra.reason?.slice(0, 500),
          providerId: extra.providerId,
        },
      })
      .then(() => status);

  if (isQuietTime(now, user.timezone, prefs.quietHoursStart, prefs.quietHoursEnd)) {
    return log('SKIPPED', { reason: 'QUIET_HOURS' });
  }
  if (!(await claimSlot(user.id, msg.task.id, now))) return log('SKIPPED', { reason: 'RATE_LIMITED' });

  try {
    const { id } = await getTransport().send(user.phoneNumber, composeMessage(msg.type, msg.task));
    return log('SENT', { providerId: id });
  } catch (error) {
    await releaseSlot(user.id, msg.task.id);
    logger.warn('whatsapp send failed', { userId: user.id, taskId: msg.task.id, error });
    return log('FAILED', { reason: error instanceof Error ? error.message : String(error) });
  }
}
