import type { Prisma, Role, Survey } from '@prisma/client';
import type { AuthUser } from '../../types';

// Who sees and manages performance surveys (Risk 1). Evaluations are HR data,
// so a JEFE_AREA's visibility grants over other areas do NOT extend to them.
//
//   ADMIN      everything in the workspace
//   JEFE_AREA  surveys they must fill, plus every survey about the TEAM of their
//              own department — never about another JEFE_AREA (a peer) or an
//              ADMIN, and never evaluations about themselves by others (CR-01)
//   USER       surveys they must fill (their self-assessments), plus the manager
//              review about them once that quarter's review is published
//   VIEWER     nothing
//
// "Team" is decided by the evaluated person's CURRENT role: someone promoted to
// area head stops being visible to the other heads of the area.

const MANAGER_ROLES: Role[] = ['ADMIN', 'JEFE_AREA'];
const isTeamMember = (role: Role) => !MANAGER_ROLES.includes(role);

type SurveyRef = Pick<Survey, 'evaluatorId' | 'evaluatedUserId' | 'departmentId' | 'type' | 'status'> & {
  evaluatedUser: { role: Role };
};

export function checkSurveyAccess(user: AuthUser, survey: SurveyRef, reviewPublished = false): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VIEWER') return false;
  if (survey.evaluatorId === user.id) return true;
  if (survey.evaluatedUserId === user.id) {
    return survey.type === 'MANAGER_REVIEW' && survey.status === 'COMPLETED' && reviewPublished;
  }
  return (
    user.role === 'JEFE_AREA' && !!user.departmentId && survey.departmentId === user.departmentId && isTeamMember(survey.evaluatedUser.role)
  );
}

// Creating, cancelling and publishing: ADMIN anywhere, JEFE_AREA for the team
// of their own department (never themselves nor a peer head).
export function canManageEvaluationsOf(user: AuthUser, subject: { id: string; departmentId: string | null; role: Role }): boolean {
  if (user.role === 'ADMIN') return true;
  return (
    user.role === 'JEFE_AREA' &&
    !!user.departmentId &&
    subject.departmentId === user.departmentId &&
    subject.id !== user.id &&
    isTeamMember(subject.role)
  );
}

// Prisma filter for "the evaluated person is a team member".
const teamMember = { role: { notIn: MANAGER_ROLES } };

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
    or.push({ departmentId: user.departmentId, evaluatedUserId: { not: user.id }, evaluatedUser: teamMember });
  }
  return { ...base, OR: or };
}

// Performance reviews: ADMIN all; JEFE_AREA their department's team (their own
// only once published); anyone their own, once published.
export function checkReviewAccess(
  user: AuthUser,
  review: { userId: string; departmentId: string | null; publishedAt: Date | null; user: { role: Role } },
): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'VIEWER') return false;
  if (review.userId === user.id) return review.publishedAt !== null;
  return user.role === 'JEFE_AREA' && !!user.departmentId && review.departmentId === user.departmentId && isTeamMember(review.user.role);
}

export function reviewVisibilityFilter(user: AuthUser): Prisma.PerformanceReviewWhereInput {
  const base: Prisma.PerformanceReviewWhereInput = { workspaceId: user.workspaceId };
  if (user.role === 'ADMIN') return base;
  const or: Prisma.PerformanceReviewWhereInput[] = [{ userId: user.id, publishedAt: { not: null } }];
  if (user.role === 'JEFE_AREA' && user.departmentId) {
    or.push({ departmentId: user.departmentId, userId: { not: user.id }, user: teamMember });
  }
  return { ...base, OR: or };
}

// The dashboard's slice for a JEFE_AREA: their team, same rule as the lists.
export const teamSurveyFilter = (user: AuthUser): Prisma.SurveyWhereInput => ({
  departmentId: user.departmentId!,
  evaluatedUserId: { not: user.id },
  evaluatedUser: teamMember,
});
export const teamReviewFilter = (user: AuthUser): Prisma.PerformanceReviewWhereInput => ({
  departmentId: user.departmentId!,
  userId: { not: user.id },
  user: teamMember,
});
