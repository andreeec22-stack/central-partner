import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email('Invalid email').max(254);

// bcrypt only uses the first 72 bytes, so longer passwords would silently be truncated.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Password is too long (max 72 bytes)');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  workspaceName: z.string().trim().min(1, 'Workspace name is required').max(50),
  displayName: z.string().trim().min(1).max(100).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
  workspaceId: z.string().uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(200).optional() }).default({});

export const resetRequestSchema = z.object({ email: emailSchema });

export const resetConfirmSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
