import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';
import { prioritySchema } from '../tasks/tasks.schemas';

export const confirmImportSchema = z.object({
  taskMappings: z
    .array(
      z.object({
        rowIndex: z.number().int().min(0),
        title: z.string().trim().min(1, 'Title is required').max(255),
        description: z.string().max(10_000).nullable().optional(),
        departmentId: z.string().uuid(),
        assignedToId: z.string().uuid().nullable().optional(),
        priority: prioritySchema.optional(),
        status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
        kpiTarget: z.string().trim().max(255).nullable().optional(),
        dueDate: z.coerce.date().nullable().optional(),
      }),
    )
    .min(1, 'Select at least one row to import')
    .max(1000)
    .refine((m) => new Set(m.map((x) => x.rowIndex)).size === m.length, 'Each row can only be imported once'),
});
export type ConfirmImportInput = z.infer<typeof confirmImportSchema>;

export const listImportsSchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
