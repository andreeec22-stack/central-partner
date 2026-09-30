import { z } from 'zod';

const weekRef = z.union([z.literal('current'), z.string().uuid()]);
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));
const amount = z.number().finite().min(-1e9).max(1e9);

export const weekQuerySchema = z.object({ weekId: weekRef.optional() });

const kpiFields = {
  title: text(120).min(1, 'Title is required'),
  description: optionalText(500),
  type: z.enum(['RESULT', 'COMPLIANCE', 'PROGRESS']),
  unit: optionalText(20),
  target: amount.min(0, 'The target cannot be negative'),
  lesserIsBetter: z.boolean(),
  order: z.number().int().min(0).max(1000),
};

// "Menos es mejor" allows a target of 0 (0 multas); otherwise the target must be positive.
const targetRule = (v: { target?: number; lesserIsBetter?: boolean }) => v.target === undefined || v.lesserIsBetter || v.target > 0;

export const createKpiSchema = z
  .object({
    weekId: weekRef.optional(),
    ...kpiFields,
    type: kpiFields.type.default('RESULT'),
    lesserIsBetter: kpiFields.lesserIsBetter.default(false),
    order: kpiFields.order.optional(),
  })
  .refine(targetRule, { message: 'The target must be greater than 0', path: ['target'] });
export type CreateKpiInput = z.infer<typeof createKpiSchema>;

export const updateKpiSchema = z
  .object({ ...kpiFields, actual: amount.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateKpiInput = z.infer<typeof updateKpiSchema>;

const functionFields = {
  title: text(160).min(1, 'Title is required'),
  description: optionalText(500),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'WHEN_OCCURS', 'WHEN_CHANGES']),
  order: z.number().int().min(0).max(1000),
};

export const createFunctionSchema = z.object({
  weekId: weekRef.optional(),
  ...functionFields,
  frequency: functionFields.frequency.default('WEEKLY'),
  order: functionFields.order.optional(),
});
export type CreateFunctionInput = z.infer<typeof createFunctionSchema>;

export const updateFunctionSchema = z
  .object({
    ...functionFields,
    fulfilled: z.enum(['YES', 'PARTIAL', 'NO', 'NOT_APPLICABLE']).nullable(),
    observation: optionalText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateFunctionInput = z.infer<typeof updateFunctionSchema>;
