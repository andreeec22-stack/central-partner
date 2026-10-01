import type { OkrLevel, Prisma, Role } from '@prisma/client';
import type { AuthUser } from '../../types';

// Who sees and changes OKRs.
//
//   read     COMPANY and AREA OKRs: everyone in the workspace (objectives are
//            meant to be visible). PERSON OKRs: the person, the heads of their
//            area (for team members, same rule as evaluations — CR-01) and ADMIN.
//   manage   create / edit / delete:
//              COMPANY  ADMIN
//              AREA     ADMIN, or a JEFE_AREA of that area
//              PERSON   ADMIN, or a JEFE_AREA of the person's area if the person
//                       is on their team (not a peer head, not themselves)
//   check in the managers above, plus the person who owns a PERSON OKR.

export interface OkrRef {
  level: OkrLevel;
  departmentId: string | null;
  ownerUserId: string | null;
  owner?: { role: Role } | null;
}

const isTeamRole = (role: Role | undefined) => role !== 'ADMIN' && role !== 'JEFE_AREA';

export function canManageOkr(user: AuthUser, okr: OkrRef): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'JEFE_AREA' || !user.departmentId || okr.departmentId !== user.departmentId) return false;
  if (okr.level === 'AREA') return true;
  return okr.level === 'PERSON' && okr.ownerUserId !== user.id && isTeamRole(okr.owner?.role);
}

export function canSeeOkr(user: AuthUser, okr: OkrRef): boolean {
  if (okr.level !== 'PERSON') return true;
  return okr.ownerUserId === user.id || canManageOkr(user, okr);
}

export function canCheckIn(user: AuthUser, okr: OkrRef): boolean {
  if (user.role === 'VIEWER') return false;
  return canManageOkr(user, okr) || (okr.level === 'PERSON' && okr.ownerUserId === user.id);
}

// canSeeOkr as a Prisma filter.
export function okrVisibilityFilter(user: AuthUser): Prisma.OkrWhereInput {
  const base: Prisma.OkrWhereInput = { workspaceId: user.workspaceId };
  if (user.role === 'ADMIN') return base;
  const or: Prisma.OkrWhereInput[] = [{ level: { in: ['COMPANY', 'AREA'] } }, { level: 'PERSON', ownerUserId: user.id }];
  if (user.role === 'JEFE_AREA' && user.departmentId) {
    or.push({ level: 'PERSON', departmentId: user.departmentId, owner: { role: { notIn: ['ADMIN', 'JEFE_AREA'] } } });
  }
  return { ...base, OR: or };
}
