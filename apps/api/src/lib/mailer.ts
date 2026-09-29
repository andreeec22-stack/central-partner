import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// Transactional email only (invites, password reset) — Confirmación F rules out
// email notifications. Without SMTP_HOST the message is logged instead (dev).
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;
const outbox: MailMessage[] = [];

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (env.NODE_ENV === 'test') {
    outbox.push(message);
    return;
  }
  const t = getTransporter();
  if (!t) {
    logger.info('email (dev, not sent)', { to: message.to, subject: message.subject, text: message.text });
    return;
  }
  await t.sendMail({ from: env.SMTP_FROM, ...message });
}

// Test helper: messages "sent" while NODE_ENV=test.
export function drainTestOutbox(): MailMessage[] {
  return outbox.splice(0, outbox.length);
}
