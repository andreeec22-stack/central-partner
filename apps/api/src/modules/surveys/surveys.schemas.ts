import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';

const questionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  questionType: z.enum(['LIKERT_5', 'LIKERT_7', 'NUMERIC', 'TEXT', 'RANKING']),
  weight: z.number().positive().max(10).default(1),
  required: z.boolean().default(true),
  options: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});
export type QuestionInput = z.infer<typeof questionSchema>;

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  questions: z.array(questionSchema).max(50),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const templateStatusSchema = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) });

export const listTemplatesSchema = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional() });

export const createSurveySchema = z.object({
  templateId: z.string().uuid(),
  type: z.enum(['SELF_ASSESSMENT', 'MANAGER_REVIEW']),
  evaluatedUserId: z.string().uuid(),
  // MANAGER_REVIEW only; defaults to whoever creates it.
  evaluatorId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullish(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  // The quarter being evaluated; defaults to the one containing startDate.
  reviewPeriod: z.string().regex(/^\d{4}-Q[1-4]$/, 'Use YYYY-Qn').optional(),
});
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;

export const listSurveysSchema = paginationSchema.extend({
  // assigned = the ones I have to fill.
  scope: z.enum(['all', 'assigned']).default('all'),
  status: z.enum(['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  departmentId: z.string().uuid().optional(),
  evaluatedUserId: z.string().uuid().optional(),
  period: z.string().regex(/^\d{4}-Q[1-4]$/).optional(),
});
export type ListSurveysQuery = z.infer<typeof listSurveysSchema>;

export const saveResponsesSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        // null clears the answer.
        value: z.union([z.number(), z.string(), z.array(z.string()), z.null()]),
        comment: z.string().trim().max(2000).nullish(),
      }),
    )
    .min(1)
    .max(50),
});
export type SaveResponsesInput = z.infer<typeof saveResponsesSchema>;

export const periodQuerySchema = z.object({ period: z.string().regex(/^\d{4}-Q[1-4]$/).optional() });

export const listReviewsSchema = paginationSchema.extend({
  period: z.string().regex(/^\d{4}-Q[1-4]$/).optional(),
  departmentId: z.string().uuid().optional(),
});

const list = z.array(z.string().trim().min(1).max(300)).max(20);
export const updateReviewSchema = z
  .object({
    managerComments: z.string().trim().max(4000).nullable(),
    employeeComments: z.string().trim().max(4000).nullable(),
    strengths: list,
    areasForImprovement: list,
    developmentGoals: list,
    nextReviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;
