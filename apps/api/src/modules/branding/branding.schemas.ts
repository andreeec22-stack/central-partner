import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #2563EB');

export const updateBrandingSchema = z
  .object({
    workspaceName: z.string().trim().min(1).max(50),
    tagline: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .transform((v) => v || null),
    colors: z.object({ primary: hexColor, success: hexColor, warning: hexColor, danger: hexColor }).partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;
