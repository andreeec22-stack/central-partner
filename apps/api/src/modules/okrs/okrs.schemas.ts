import { z } from 'zod';

const period = z.string().regex(/^\d{4}-Q[1-4]$/, 'Use YYYY-Qn');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const keyResultSchema = z.object({
  // Present = keep that key result (and its current value); absent = new one.
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(20).nullish(),
  startValue: z.number().finite().default(0),
  target: z.number().finite(),
});
export type KeyResultInput = z.infer<typeof keyResultSchema>;

export const MAX_KEY_RESULTS = 5;

export const createOkrSchema = z.object({
  period,
  level: z.enum(['COMPANY', 'AREA', 'PERSON']),
  parentId: z.string().uuid().nullish(),
  // AREA: required. PERSON: taken from the owner.
  departmentId: z.string().uuid().optional(),
  // PERSON: required.
  ownerUserId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  deadline: day.nullish(),
  keyResults: z.array(keyResultSchema).min(1).max(MAX_KEY_RESULTS),
});
export type CreateOkrInput = z.infer<typeof createOkrSchema>;

// Level, area and owner are fixed once created.
export const updateOkrSchema = z
  .object({
    parentId: z.string().uuid().nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    deadline: day.nullable(),
    keyResults: z.array(keyResultSchema).min(1).max(MAX_KEY_RESULTS),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateOkrInput = z.infer<typeof updateOkrSchema>;

export const checkInSchema = z
  .object({
    keyResults: z.array(z.object({ id: z.string().uuid(), current: z.number().finite() })).max(MAX_KEY_RESULTS).default([]),
    notes: z.string().trim().max(2000).nullish(),
  })
  .refine((v) => v.keyResults.length > 0 || !!v.notes, 'Actualiza al menos un resultado clave o escribe una nota');
export type CheckInInput = z.infer<typeof checkInSchema>;

export const listOkrsSchema = z.object({
  period,
  level: z.enum(['COMPANY', 'AREA', 'PERSON']).optional(),
  departmentId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
});
export type ListOkrsQuery = z.infer<typeof listOkrsSchema>;
