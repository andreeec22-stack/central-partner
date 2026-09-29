import type { Prisma, Role } from '@prisma/client';
import { env } from '../../config/env';
import { generateOpaqueToken, sha256 } from '../../lib/crypto';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { sendMail } from '../../lib/mailer';
import { hashPassword, verifyPassword } from '../../lib/password';
import { invalidatePermissions } from '../../lib/permissions';
import { prisma, type Tx } from '../../lib/prisma';
import { disconnectUser } from '../../lib/realtime';
import { refreshUserRooms } from '../../realtime/socket-server';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import { startSession, toPublicUser, toPublicWorkspace, type ClientContext } from '../auth/auth.service';
import type { AcceptInviteInput, InviteInput, UpdateProfileInput, UpdateUserInput } from './users.schemas';

// Confirmación D: invitation links expire after 24 hours.
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador',
  JEFE_AREA: 'Jefe de Área',
  USER: 'Usuario',
  VIEWER: 'Lector',
};

const userSelect = {
  id: true,
  workspaceId: true,
  email: true,
  displayName: true,
  role: true,
  canCreateTasks: true,
  departmentId: true,
  phoneNumber: true,
  timezone: true,
  lastLoginAt: true,
  createdAt: true,
  deletedAt: true,
  department: { select: { id: true, name: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

// Phone numbers and account state are only shown to ADMINs and the user themself.
function present(row: UserRow, viewer: AuthUser) {
  const privileged = viewer.role === 'ADMIN' || viewer.id === row.id;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    canCreateTasks: row.role === 'ADMIN' || row.canCreateTasks,
    departmentId: row.departmentId,
    department: row.department,
    timezone: row.timezone,
    ...(privileged ? { phoneNumber: row.phoneNumber, lastLoginAt: row.lastLoginAt, createdAt: row.createdAt, deletedAt: row.deletedAt } : {}),
  };
}

async function assertDepartment(db: Tx, workspaceId: string, departmentId: string | null | undefined) {
  if (!departmentId) return;
  const dept = await db.department.findFirst({ where: { id: departmentId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!dept) throw validationError('Department not found', [{ field: 'departmentId', message: 'invalid' }]);
}

async function assertNotLastAdmin(db: Tx, workspaceId: string, userId: string) {
  const otherAdmins = await db.user.count({ where: { workspaceId, role: 'ADMIN', deletedAt: null, id: { not: userId } } });
  if (otherAdmins === 0) throw conflict('The workspace must keep at least one administrator', 'LAST_ADMIN');
}

// The task-creation grant only exists for JEFE_AREA; any other role stores false.
function grantFor(role: Role, requested: boolean | undefined): boolean {
  return role === 'JEFE_AREA' && requested === true;
}

export async function listUsers(
  viewer: AuthUser,
  q: { departmentId?: string; search?: string; status: 'active' | 'deleted' | 'all'; page: number; limit: number },
) {
  // Deactivated accounts are an admin concern.
  const status = viewer.role === 'ADMIN' ? q.status : 'active';
  const where: Prisma.UserWhereInput = {
    workspaceId: viewer.workspaceId,
    ...(status === 'active' ? { deletedAt: null } : status === 'deleted' ? { deletedAt: { not: null } } : {}),
    ...(q.departmentId ? { departmentId: q.departmentId } : {}),
    ...(q.search
      ? {
          OR: [
            { displayName: { contains: q.search, mode: 'insensitive' } },
            { email: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: { displayName: 'asc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.user.count({ where }),
  ]);
  return { data: rows.map((r) => present(r, viewer)), total, page: q.page, limit: q.limit };
}

export async function inviteUser(admin: AuthUser, input: InviteInput, ctx: ClientContext) {
  const token = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const { invitation, workspaceName } = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { workspaceId_email: { workspaceId: admin.workspaceId, email: input.email } },
      select: { deletedAt: true },
    });
    if (existing && !existing.deletedAt) throw conflict('This person already has an account in the workspace', 'USER_EXISTS');
    if (existing?.deletedAt) {
      throw conflict('This account was deactivated; restore it instead of inviting again', 'USER_DEACTIVATED');
    }
    await assertDepartment(tx, admin.workspaceId, input.departmentId);

    // Only the newest invitation for an email is valid.
    await tx.invitation.updateMany({
      where: { workspaceId: admin.workspaceId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const invitation = await tx.invitation.create({
      data: {
        workspaceId: admin.workspaceId,
        email: input.email,
        role: input.role,
        canCreateTasks: grantFor(input.role, input.canCreateTasks),
        departmentId: input.departmentId ?? null,
        phoneNumber: input.phoneNumber ?? null,
        tokenHash: sha256(token),
        expiresAt,
        invitedById: admin.id,
      },
    });
    await logActivity(
      {
        workspaceId: admin.workspaceId,
        userId: admin.id,
        action: ActivityAction.USER_INVITED,
        entityType: 'Invitation',
        entityId: invitation.id,
        metadata: {
          email: input.email,
          role: input.role,
          departmentId: input.departmentId ?? null,
          canCreateTasks: grantFor(input.role, input.canCreateTasks),
        },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: admin.workspaceId }, select: { name: true } });
    return { invitation, workspaceName: workspace.name };
  });

  const link = `${env.APP_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: input.email,
    subject: `${admin.displayName} te invitó a ${workspaceName}`,
    text:
      `Hola,\n\n${admin.displayName} te invitó a unirte a ${workspaceName} en Central Partner ` +
      `como ${ROLE_LABEL[input.role]}.\n\nAcepta la invitación y crea tu contraseña aquí (válido 24 horas):\n${link}\n`,
  }).catch((error) => logger.error('invitation email failed', { invitationId: invitation.id, error }));

  return { invitationSent: true, invitationId: invitation.id, expiresAt };
}

export async function listPendingInvitations(admin: AuthUser) {
  const rows = await prisma.invitation.findMany({
    where: { workspaceId: admin.workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, canCreateTasks: true, departmentId: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return { data: rows };
}

export async function revokeInvitation(admin: AuthUser, invitationId: string) {
  const result = await prisma.invitation.updateMany({
    where: { id: invitationId, workspaceId: admin.workspaceId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw notFound('Invitation');
}

async function findUsableInvitation(db: Tx, token: string) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { workspace: { select: { id: true, name: true, slug: true, deletedAt: true } } },
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date() || invitation.workspace.deletedAt) {
    throw validationError('This invitation is invalid or has expired', [{ field: 'token', message: 'invalid' }]);
  }
  return invitation;
}

// Lets the accept page show who is inviting and for which email.
export async function describeInvitation(token: string) {
  const invitation = await findUsableInvitation(prisma, token);
  return {
    email: invitation.email,
    role: invitation.role,
    workspaceName: invitation.workspace.name,
    expiresAt: invitation.expiresAt,
  };
}

export async function acceptInvitation(input: AcceptInviteInput, ctx: ClientContext) {
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const invitation = await findUsableInvitation(tx, input.token);
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw validationError('This invitation has already been used', [{ field: 'token', message: 'used' }]);

    const departmentStillActive = invitation.departmentId
      ? await tx.department.count({ where: { id: invitation.departmentId, deletedAt: null } })
      : 0;
    const existing = await tx.user.findUnique({
      where: { workspaceId_email: { workspaceId: invitation.workspaceId, email: invitation.email } },
      select: { id: true },
    });
    if (existing) throw conflict('An account with this email already exists in the workspace', 'USER_EXISTS');

    const user = await tx.user.create({
      data: {
        workspaceId: invitation.workspaceId,
        email: invitation.email,
        passwordHash,
        displayName: input.displayName,
        role: invitation.role,
        canCreateTasks: grantFor(invitation.role, invitation.canCreateTasks),
        departmentId: departmentStillActive ? invitation.departmentId : null,
        phoneNumber: invitation.phoneNumber,
        lastLoginAt: new Date(),
        notificationPrefs: { create: { workspaceId: invitation.workspaceId } },
      },
    });
    await logActivity(
      {
        workspaceId: invitation.workspaceId,
        userId: user.id,
        action: ActivityAction.INVITATION_ACCEPTED,
        entityType: 'User',
        entityId: user.id,
        metadata: { invitationId: invitation.id, role: user.role, departmentId: user.departmentId, canCreateTasks: user.canCreateTasks },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    const tokens = await startSession(tx, user, ctx);
    return { user: toPublicUser(user), workspace: toPublicWorkspace(invitation.workspace), ...tokens };
  });
}

type UserFields = Omit<UpdateUserInput, 'notificationPreferences'> & { email?: string };
type PreferencesInput = UpdateUserInput['notificationPreferences'];

// Shared write path for admin edits and self-service profile edits: validation,
// the write itself, and audit entries for user fields and preferences.
async function applyUserUpdate(
  actor: AuthUser,
  userId: string,
  fields: UserFields,
  prefs: PreferencesInput,
  ctx: ClientContext,
  guard?: (tx: Tx, target: { email: string; passwordHash: string }) => Promise<void>,
) {
  const { updated, accessChanged } = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({
      where: { id: userId, workspaceId: actor.workspaceId, deletedAt: null },
      include: { notificationPrefs: true },
    });
    if (!target) throw notFound('User');
    await guard?.(tx, target);

    if (fields.role && fields.role !== 'ADMIN' && target.role === 'ADMIN') await assertNotLastAdmin(tx, actor.workspaceId, userId);
    await assertDepartment(tx, actor.workspaceId, fields.departmentId);

    // Keep the grant consistent with the role: it only survives on a JEFE_AREA.
    const roleAfter = fields.role ?? target.role;
    const data: UserFields = { ...fields };
    if (roleAfter !== 'JEFE_AREA' && (target.canCreateTasks || fields.canCreateTasks !== undefined)) {
      data.canCreateTasks = false;
    }

    const phoneAfter = data.phoneNumber !== undefined ? data.phoneNumber : target.phoneNumber;
    const whatsAppAfter = prefs?.enableWhatsApp ?? target.notificationPrefs?.enableWhatsApp ?? false;
    if (whatsAppAfter && !phoneAfter) {
      throw validationError('WhatsApp notifications need a phone number', [{ field: 'phoneNumber', message: 'required' }]);
    }

    const changes = diffFields(target as unknown as Record<string, unknown>, data);
    const updated = await tx.user.update({ where: { id: userId }, data, select: userSelect });

    if (prefs) {
      const prefsData = {
        ...prefs,
        ...(prefs.whatsAppEvents ? { whatsAppEvents: prefs.whatsAppEvents as Prisma.InputJsonValue } : {}),
      };
      const before = target.notificationPrefs;
      await tx.userNotificationPreferences.upsert({
        where: { userId },
        create: { workspaceId: actor.workspaceId, userId, ...prefsData },
        update: prefsData,
      });
      const prefChanges = diffFields((before ?? {}) as unknown as Record<string, unknown>, prefs as Record<string, unknown>);
      if (Object.keys(prefChanges).length) {
        await logActivity(
          {
            workspaceId: actor.workspaceId,
            userId: actor.id,
            action: ActivityAction.NOTIFICATION_PREFERENCES_UPDATED,
            entityType: 'User',
            entityId: userId,
            changes: prefChanges,
            ipAddress: ctx.ipAddress,
          },
          tx,
        );
      }
    }

    if (Object.keys(changes).length) {
      await logActivity(
        {
          workspaceId: actor.workspaceId,
          userId: actor.id,
          action: ActivityAction.USER_UPDATED,
          entityType: 'User',
          entityId: userId,
          changes,
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
    }
    return { updated, accessChanged: 'role' in changes || 'departmentId' in changes };
  });

  if (accessChanged) {
    await invalidatePermissions(userId);
    await refreshUserRooms(userId);
  }
  return { user: present(updated, actor) };
}

// PATCH /users/:id — ADMIN only (Confirmación B): role, department, the
// JEFE_AREA task-creation grant, and any profile field.
export async function updateUser(admin: AuthUser, userId: string, input: UpdateUserInput, ctx: ClientContext) {
  if (admin.role !== 'ADMIN') throw forbidden();
  const { notificationPreferences, ...fields } = input;
  return applyUserUpdate(admin, userId, fields, notificationPreferences, ctx);
}

// PATCH /users/:id/profile — the user themself: name, email, phone, timezone,
// notification preferences. Never role, department or permissions.
export async function updateProfile(actor: AuthUser, userId: string, input: UpdateProfileInput, ctx: ClientContext) {
  if (actor.id !== userId) throw forbidden('You can only edit your own profile');
  const { notificationPreferences, currentPassword, ...fields } = input;

  return applyUserUpdate(actor, userId, fields, notificationPreferences, ctx, async (tx, target) => {
    if (!fields.email || fields.email === target.email) return;
    if (!currentPassword || !(await verifyPassword(currentPassword, target.passwordHash))) {
      throw validationError('Current password is incorrect', [{ field: 'currentPassword', message: 'incorrect' }]);
    }
    const taken = await tx.user.findUnique({
      where: { workspaceId_email: { workspaceId: actor.workspaceId, email: fields.email } },
      select: { id: true },
    });
    if (taken) throw conflict('That email is already used in this workspace', 'EMAIL_TAKEN');
  });
}

export async function deleteUser(admin: AuthUser, userId: string, ctx: ClientContext) {
  if (admin.id === userId) throw conflict('You cannot deactivate your own account', 'CANNOT_DELETE_SELF');
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({ where: { id: userId, workspaceId: admin.workspaceId, deletedAt: null } });
    if (!target) throw notFound('User');
    if (target.role === 'ADMIN') await assertNotLastAdmin(tx, admin.workspaceId, userId);
    const now = new Date();
    await tx.user.update({ where: { id: userId }, data: { deletedAt: now } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await logActivity(
      {
        workspaceId: admin.workspaceId,
        userId: admin.id,
        action: ActivityAction.USER_DELETED,
        entityType: 'User',
        entityId: userId,
        metadata: { email: target.email, role: target.role },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  await invalidatePermissions(userId);
  await disconnectUser(userId);
}

export async function restoreUser(admin: AuthUser, userId: string, ctx: ClientContext) {
  const restored = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({ where: { id: userId, workspaceId: admin.workspaceId, deletedAt: { not: null } } });
    if (!target) throw notFound('Deactivated user');
    // Their department may have been deleted meanwhile.
    const deptActive = target.departmentId
      ? await tx.department.count({ where: { id: target.departmentId, deletedAt: null } })
      : 0;
    const user = await tx.user.update({
      where: { id: userId },
      data: { deletedAt: null, ...(deptActive ? {} : { departmentId: null }) },
      select: userSelect,
    });
    await logActivity(
      {
        workspaceId: admin.workspaceId,
        userId: admin.id,
        action: ActivityAction.USER_RESTORED,
        entityType: 'User',
        entityId: userId,
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return user;
  });
  return { user: present(restored, admin) };
}

export async function getNotificationPreferences(actor: AuthUser, userId: string) {
  if (actor.role !== 'ADMIN' && actor.id !== userId) throw forbidden();
  const user = await prisma.user.findFirst({
    where: { id: userId, workspaceId: actor.workspaceId },
    select: { timezone: true, notificationPrefs: true },
  });
  if (!user) throw notFound('User');
  const p = user.notificationPrefs;
  return {
    enableWhatsApp: p?.enableWhatsApp ?? false,
    whatsAppEvents: p?.whatsAppEvents ?? {},
    timezone: user.timezone,
    quietHoursStart: p?.quietHoursStart ?? null,
    quietHoursEnd: p?.quietHoursEnd ?? null,
  };
}
