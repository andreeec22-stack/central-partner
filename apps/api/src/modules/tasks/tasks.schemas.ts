import { z } from 'zod';

export const taskStatusSchema = z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
export const prioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

const shortText = z.string().trim().max(255);
const optionalText = shortText.nullable().optional().transform((v) => (v === '' ? null : v));
const dateInput = z.coerce.date().nullable().optional();

// Comma-separated list in the query string: ?status=TODO,BLOCKED
const csvOf = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item).min(1))
    .optional();

export const listTasksSchema = z.object({
  departmentId: z.string().uuid().optional(),
  status: csvOf(taskStatusSchema),
  priority: csvOf(prioritySchema),
  assignedTo: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  week: z.enum(['last', 'this', 'next']).optional(),
  includeBlocked: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  parentTaskId: z.string().uuid().optional(),
  sourceType: z.enum(['MANUAL', 'EXCEL_IMPORT']).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'dueDate', 'priority', 'progress', 'title']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTasksQuery = z.infer<typeof listTasksSchema>;

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(255),
  description: z.string().max(10_000).nullable().optional(),
  departmentId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  priority: prioritySchema.default('MEDIUM'),
  dueDate: dateInput,
  kpiTarget: optionalText,
  kpiActual: optionalText,
  parentTaskId: z.string().uuid().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: z.string().max(10_000).nullable(),
    departmentId: z.string().uuid(),
    assignedTo: z.string().uuid().nullable(),
    status: taskStatusSchema,
    priority: prioritySchema,
    progress: z.number().int(),
    dueDate: z.coerce.date().nullable(),
    kpiTarget: shortText.nullable(),
    kpiActual: shortText.nullable(),
    blockReason: shortText.nullable(),
    parentTaskId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const bulkUpdateSchema = z.object({
  taskIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100, 'At most 100 tasks per request')
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate task ids'),
  updates: z
    .object({
      status: taskStatusSchema,
      priority: prioritySchema,
      progress: z.number().int(),
      assignedTo: z.string().uuid().nullable(),
      departmentId: z.string().uuid(),
      dueDate: z.coerce.date().nullable(),
      blockReason: shortText.nullable(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
});
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;

export const addDependencySchema = z.object({ dependsOnTaskId: z.string().uuid() });
