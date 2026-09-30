import type { Prisma, Survey } from '@prisma/client';
import type { AuthUser } from '../../types';

// Who sees and manages performance surveys (Risk 1). Evaluations are HR data,
// so a JEFE_AREA's visibility grants over other areas do NOT extend to them.
//
//   ADMIN      everything in the workspace
//   JEFE_AREA  surveys they must fill, plus every survey about people of their
//              own department — except evaluations about themselves by others
//   USER       surveys they must fill (their self-assessments), plus the manager
//              review about them once that quarter's review is published
//   VIEWER     nothing

type SurveyRef = Pick<Survey, 'evaluatorId' | 'evaluatedUserId' | 'departmentId' | 'type' | 'status'>;

export function checkSurveyAccess(user: AuthUser, survey: SurveyRef, reviewPublished = false): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VIEWER') return false;
  if (survey.evaluatorId === user.id) return true;
  if (survey.evaluatedUserId === user.id) {
    return survey.type === 'MANAGER_REVIEW' && survey.status === 'COMPLETED' && reviewPublished;
  }
  return user.role === 'JEFE_AREA' && !!user.departmentId && survey.departmentId === user.departmentId;
}

// Creating, cancelling and publishing: ADMIN anywhere, JEFE_AREA for the
// people of their own department (never their own evaluation).
export function canManageEvaluationsOf(user: AuthUser, subject: { id: string; departmentId: string | null }): boolean {
  if (user.role === 'ADMIN') return true;
  return user.role === 'JEFE_AREA' && !!user.departmentId && subject.departmentId === user.departmentId && subject.id !== user.id;
}

// The same rule as checkSurveyAccess, as a Prisma filter for lists.
// `publishedPeriods` are the quarters whose review about `user` is published.
export function surveyVisibilityFilter(user: AuthUser, publishedPeriods: string[]): Prisma.SurveyWhereInput {
  const base: Prisma.SurveyWhereInput = { workspaceId: user.workspaceId };
  if (user.role === 'ADMIN') return base;
  const or: Prisma.SurveyWhereInput[] = [{ evaluatorId: user.id }];
  if (publishedPeriods.length) {
    or.push({ evaluatedUserId: user.id, type: 'MANAGER_REVIEW', status: 'COMPLETED', reviewPeriod: { in: publishedPeriods } });
  }
  if (user.role === 'JEFE_AREA' && user.departmentId) {
    or.push({ departmentId: user.departmentId, evaluatedUserId: { not: user.id } });
  }
  return { ...base, OR: or };
}

// Performance reviews: ADMIN all; JEFE_AREA their department's (their own only
// once published); anyone their own, once published.
export function checkReviewAccess(user: AuthUser, review: { userId: string; departmentId: string | null; publishedAt: Date | null }): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VIEWER') return false;
  if (review.userId === user.id) return review.publishedAt !== null;
  return user.role === 'JEFE_AREA' && !!user.departmentId && review.departmentId === user.departmentId;
}

export function reviewVisibilityFilter(user: AuthUser): Prisma.PerformanceReviewWhereInput {
  const base: Prisma.PerformanceReviewWhereInput = { workspaceId: user.workspaceId };
  if (user.role === 'ADMIN') return base;
  const or: Prisma.PerformanceReviewWhereInput[] = [{ userId: user.id, publishedAt: { not: null } }];
  if (user.role === 'JEFE_AREA' && user.departmentId) or.push({ departmentId: user.departmentId, userId: { not: user.id } });
  return { ...base, OR: or };
}
