import type { SurveyTemplateStatus } from '@prisma/client';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import type { CreateTemplateInput, QuestionInput, UpdateTemplateInput } from './surveys.schemas';
import { validateTemplateQuestions } from './surveys.validators';

// Templates are written by an ADMIN as DRAFT, then ACTIVATED — from then on
// their questions are frozen (surveys are answered against them) and they can
// only be archived or re-activated. JEFE_AREAs read the active ones to create surveys.

const withQuestions = { questions: { orderBy: { questionNumber: 'asc' as const } }, _count: { select: { surveys: true } } };

type TemplateRow = NonNullable<Awaited<ReturnType<typeof findTemplateRow>>>;

function findTemplateRow(workspaceId: string, id: string) {
  return prisma.surveyTemplate.findFirst({ where: { id, workspaceId }, include: withQuestions });
}

export function presentTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    status: t.status,
    surveysCount: t._count.surveys,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    questions: t.questions.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      questionType: q.questionType,
      weight: q.weight,
      required: q.required,
      options: q.options,
    })),
  };
}

const questionRows = (questions: QuestionInput[]) =>
  questions.map((q, i) => ({ ...q, options: q.questionType === 'RANKING' ? q.options : [], questionNumber: i + 1 }));

export async function listTemplates(user: AuthUser, status?: SurveyTemplateStatus) {
  if (user.role !== 'ADMIN' && user.role !== 'JEFE_AREA') throw forbidden();
  // Area heads only need the ones they can use.
  const effective = user.role === 'ADMIN' ? status : 'ACTIVE';
  const rows = await prisma.surveyTemplate.findMany({
    where: { workspaceId: user.workspaceId, ...(effective ? { status: effective } : {}) },
    include: withQuestions,
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
  });
  return { data: rows.map(presentTemplate) };
}

export async function getTemplate(user: AuthUser, id: string) {
  if (user.role !== 'ADMIN' && user.role !== 'JEFE_AREA') throw forbidden();
  const t = await findTemplateRow(user.workspaceId, id);
  if (!t || (user.role !== 'ADMIN' && t.status !== 'ACTIVE')) throw notFound('Template');
  return { template: presentTemplate(t) };
}

export async function createTemplate(user: AuthUser, input: CreateTemplateInput, ctx: ClientContext) {
  validateTemplateQuestions(input.questions);
  const created = await prisma.$transaction(async (tx) => {
    const t = await tx.surveyTemplate.create({
      data: {
        workspaceId: user.workspaceId,
        name: input.name,
        description: input.description ?? null,
        createdById: user.id,
        questions: { create: questionRows(input.questions) },
      },
    });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.SURVEY_TEMPLATE_CREATED,
        entityType: 'SurveyTemplate',
        entityId: t.id,
        metadata: { name: t.name, questions: input.questions.length },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return t;
  });
  return { template: presentTemplate((await findTemplateRow(user.workspaceId, created.id))!) };
}

export async function updateTemplate(user: AuthUser, id: string, input: UpdateTemplateInput, ctx: ClientContext) {
  const current = await findTemplateRow(user.workspaceId, id);
  if (!current) throw notFound('Template');
  if (current.status !== 'DRAFT') throw new AppError(409, 'TEMPLATE_LOCKED', 'Solo se editan plantillas en borrador; esta ya se usa o se usó');
  if (input.questions) validateTemplateQuestions(input.questions);

  await prisma.$transaction(async (tx) => {
    await tx.surveyTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      },
    });
    if (input.questions) {
      await tx.surveyQuestion.deleteMany({ where: { templateId: id } });
      await tx.surveyQuestion.createMany({ data: questionRows(input.questions).map((q) => ({ ...q, templateId: id })) });
    }
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.SURVEY_TEMPLATE_UPDATED,
        entityType: 'SurveyTemplate',
        entityId: id,
        metadata: { name: input.name ?? current.name, questionsReplaced: !!input.questions },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  return { template: presentTemplate((await findTemplateRow(user.workspaceId, id))!) };
}

const TRANSITIONS: Record<SurveyTemplateStatus, SurveyTemplateStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: ['ACTIVE'],
};

export async function setTemplateStatus(user: AuthUser, id: string, status: SurveyTemplateStatus, ctx: ClientContext) {
  const current = await findTemplateRow(user.workspaceId, id);
  if (!current) throw notFound('Template');
  if (current.status === status) return { template: presentTemplate(current) };
  if (!TRANSITIONS[current.status].includes(status)) {
    throw conflict(`Una plantilla ${current.status} no puede pasar a ${status}`, 'INVALID_TRANSITION');
  }
  // Re-checked on activation: the rules may be newer than the draft.
  if (status === 'ACTIVE') validateTemplateQuestions(current.questions);

  await prisma.surveyTemplate.update({ where: { id }, data: { status } });
  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.SURVEY_TEMPLATE_UPDATED,
    entityType: 'SurveyTemplate',
    entityId: id,
    changes: { status: { old: current.status, new: status } },
    ipAddress: ctx.ipAddress,
  });
  return { template: presentTemplate((await findTemplateRow(user.workspaceId, id))!) };
}

export async function deleteTemplate(user: AuthUser, id: string, ctx: ClientContext) {
  const current = await findTemplateRow(user.workspaceId, id);
  if (!current) throw notFound('Template');
  if (current.status !== 'DRAFT' || current._count.surveys > 0) {
    throw new AppError(409, 'TEMPLATE_LOCKED', 'Solo se eliminan borradores sin encuestas; archiva la plantilla en su lugar');
  }
  await prisma.surveyTemplate.delete({ where: { id } });
  await logActivity({
    workspaceId: user.workspaceId,
    userId: user.id,
    action: ActivityAction.SURVEY_TEMPLATE_DELETED,
    entityType: 'SurveyTemplate',
    entityId: id,
    metadata: { name: current.name },
    ipAddress: ctx.ipAddress,
  });
}
