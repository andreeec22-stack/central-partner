import { z } from 'zod';
import { isValidTimeZone } from '../../lib/time';
import { emailSchema, passwordSchema } from '../auth/auth.schemas';

const roleSchema = z.enum(['ADMIN', 'JEFE_AREA', 'USER', 'VIEWER']);
// E.164, as Twilio expects for WhatsApp.
const phoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +573001234567');
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const listUsersSchema = z.object({
  departmentId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'deleted', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const inviteSchema = z
  .object({
    email: emailSchema,
    role: roleSchema,
    departmentId: z.string().uuid().nullable().optional(),
    phoneNumber: phoneSchema.nullable().optional(),
  })
  .refine((v) => v.role === 'ADMIN' || !!v.departmentId, {
    message: 'A department is required for this role',
    path: ['departmentId'],
  });
export type InviteInput = z.infer<typeof inviteSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(100),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const notificationPreferencesSchema = z
  .object({
    enableWhatsApp: z.boolean(),
    whatsAppEvents: z.record(z.enum(['TASK_ASSIGNED', 'MENTIONED', 'COMMENT_REPLY', 'TASK_BLOCKED', 'TASK_COMPLETED', 'KPI_REMINDER']), z.boolean()),
    quietHoursStart: timeOfDay.nullable(),
    quietHoursEnd: timeOfDay.nullable(),
  })
  .partial()
  .refine(
    (v) => (v.quietHoursStart === undefined) === (v.quietHoursEnd === undefined) && (v.quietHoursStart === null) === (v.quietHoursEnd === null),
    { message: 'Set both quiet-hours ends, or clear both', path: ['quietHoursStart'] },
  );

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    role: roleSchema,
    departmentId: z.string().uuid().nullable(),
    phoneNumber: phoneSchema.nullable(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown IANA timezone'),
    notificationPreferences: notificationPreferencesSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
