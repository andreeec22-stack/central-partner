import type { SurveyQuestionType, SurveyTemplate, User } from '@prisma/client';
import { AppError, notFound, validationError } from '../../lib/errors';
import { isScored } from './scoring';
import type { CreateSurveyInput, QuestionInput } from './surveys.schemas';

// Business rules of the surveys, in one place. Zod (surveys.schemas.ts) checks
// shapes; these check meaning, and every service path goes through them.
// Each failure is a 422 VALIDATION_ERROR listing the offending fields.

type FieldError = { field: string; message: string };

function fail(message: string, errors: FieldError[]): never {
  throw validationError(message, errors);
}

export const MIN_QUESTIONS = 3;

// Risk 3: a template must be able to produce a performance score.
export function validateTemplateQuestions(questions: QuestionInput[]) {
  const errors: FieldError[] = [];
  if (questions.length < MIN_QUESTIONS) {
    errors.push({ field: 'questions', message: `La plantilla necesita al menos ${MIN_QUESTIONS} preguntas` });
  }
  if (!questions.some((q) => isScored(q.questionType))) {
    errors.push({ field: 'questions', message: 'Incluye al menos una pregunta LIKERT_5, LIKERT_7 o NUMERIC para calcular el puntaje' });
  }
  questions.forEach((q, i) => {
    if (q.questionType === 'RANKING') {
      if (q.options.length < 2) errors.push({ field: `questions.${i}.options`, message: 'Un ranking necesita al menos 2 opciones' });
      if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) {
        errors.push({ field: `questions.${i}.options`, message: 'Las opciones del ranking no pueden repetirse' });
      }
    } else if (q.options.length > 0) {
      errors.push({ field: `questions.${i}.options`, message: 'Solo las preguntas RANKING llevan opciones' });
    }
  });
  if (errors.length) fail('La plantilla no es válida', errors);
}

export function validateCreateSurveyData(data: Pick<CreateSurveyInput, 'startDate' | 'endDate'>, now = new Date()) {
  const errors: FieldError[] = [];
  if (data.startDate >= data.endDate) errors.push({ field: 'endDate', message: 'La fecha de fin debe ser posterior a la de inicio' });
  if (data.endDate < now) errors.push({ field: 'endDate', message: 'La fecha de fin no puede estar en el pasado' });
  if (errors.length) fail('Fechas inválidas', errors);
}

export function validateTemplateStatus(template: Pick<SurveyTemplate, 'status'> | null): asserts template {
  if (!template) throw notFound('Template');
  if (template.status !== 'ACTIVE') fail('La plantilla debe estar ACTIVA para crear encuestas', [{ field: 'templateId', message: template.status }]);
}

export function validateUserExists(
  user: Pick<User, 'workspaceId' | 'deletedAt' | 'departmentId'> | null,
  workspaceId: string,
  field = 'evaluatedUserId',
): asserts user {
  if (!user || user.workspaceId !== workspaceId || user.deletedAt) fail('Usuario no encontrado en el espacio', [{ field, message: 'not found' }]);
}

// Submitting needs every required question answered.
export function validateSurveyCompletion(questions: { id: string; required: boolean }[], answeredIds: Set<string>) {
  const missing = questions.filter((q) => q.required && !answeredIds.has(q.id));
  if (missing.length) {
    throw new AppError(422, 'SURVEY_INCOMPLETE', `Faltan ${missing.length} preguntas obligatorias por responder`, {
      missingQuestionIds: missing.map((q) => q.id),
    });
  }
}

// An answer must fit its question: LIKERT_5 1–5, LIKERT_7 1–7 (integers),
// NUMERIC 0–100, TEXT non-empty text, RANKING a permutation of the options.
export function validateAnswerValue(question: { questionType: SurveyQuestionType; options: string[] }, value: unknown): string | null {
  switch (question.questionType) {
    case 'LIKERT_5':
    case 'LIKERT_7': {
      const max = question.questionType === 'LIKERT_5' ? 5 : 7;
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? null : `Debe ser un entero entre 1 y ${max}`;
    }
    case 'NUMERIC':
      return typeof value === 'number' && value >= 0 && value <= 100 ? null : 'Debe ser un número entre 0 y 100';
    case 'TEXT':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 4000 ? null : 'Debe ser un texto (máx. 4000 caracteres)';
    case 'RANKING': {
      if (!Array.isArray(value) || value.length !== question.options.length) return 'Ordena todas las opciones';
      const given = [...value].sort();
      const expected = [...question.options].sort();
      return given.every((v, i) => v === expected[i]) ? null : 'El ranking debe contener cada opción una vez';
    }
  }
}
