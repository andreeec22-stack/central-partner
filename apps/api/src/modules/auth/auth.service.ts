import type { Role, User, Workspace } from '@prisma/client';
import { env } from '../../config/env';
import { generateOpaqueToken, sha256 } from '../../lib/crypto';
import { conflict, unauthorized, validationError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { sendMail } from '../../lib/mailer';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password';
import { prisma, type Tx } from '../../lib/prisma';
import { disconnectSession, disconnectUser } from '../../lib/realtime';
import { slugify } from '../../lib/slug';
import { signAccessToken } from '../../lib/tokens';
import { ActivityAction, logActivity } from '../audit/activity-log';
import type { LoginInput, RegisterInput } from './auth.schemas';

export interface ClientContext {
  ipAddress: string;
  userAgent?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function toPublicUser(user: Pick<User, 'id' | 'workspaceId' | 'email' | 'displayName' | 'role' | 'departmentId' | 'phoneNumber' | 'timezone'>) {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    departmentId: user.departmentId,
    phoneNumber: user.phoneNumber,
    timezone: user.timezone,
  };
}

export function toPublicWorkspace(workspace: Pick<Workspace, 'id' | 'name' | 'slug'>) {
  return { id: workspace.id, name: workspace.name, slug: workspace.slug };
}

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

async function issueRefreshToken(db: Tx, sessionId: string, expiresAt: Date): Promise<string> {
  const refreshToken = generateOpaqueToken();
  await db.refreshToken.create({ data: { sessionId, tokenHash: sha256(refreshToken), expiresAt } });
  return refreshToken;
}

function accessTokenFor(user: { id: string; workspaceId: string; role: Role }, sessionId: string) {
  return signAccessToken({ sub: user.id, wid: user.workspaceId, sid: sessionId, role: user.role });
}

export async function startSession(
  db: Tx,
  user: { id: string; workspaceId: string; role: Role },
  ctx: ClientContext,
): Promise<IssuedTokens> {
  const expiresAt = refreshExpiry();
  const session = await db.session.create({
    data: {
      userId: user.id,
      workspaceId: user.workspaceId,
      expiresAt,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent?.slice(0, 255),
    },
  });
  const refreshToken = await issueRefreshToken(db, session.id, expiresAt);
  return { accessToken: accessTokenFor(user, session.id), refreshToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}

async function uniqueWorkspaceSlug(db: Tx, name: string): Promise<string> {
  const base = slugify(name) || 'workspace';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${generateOpaqueToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const taken = await db.workspace.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// Confirmación B: whoever registers creates a workspace and becomes its ADMIN.
export async function register(input: RegisterInput, ctx: ClientContext) {
  const passwordHash = await hashPassword(input.password);
  const displayName = input.displayName ?? input.email.split('@')[0]!;

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: input.workspaceName,
        slug: await uniqueWorkspaceSlug(tx, input.workspaceName),
        branding: { create: { workspaceName: input.workspaceName } },
      },
    });
    const user = await tx.user.create({
      data: {
        workspaceId: workspace.id,
        email: input.email,
        passwordHash,
        displayName,
        role: 'ADMIN',
        lastLoginAt: new Date(),
        notificationPrefs: { create: { workspaceId: workspace.id } },
      },
    });
    await logActivity(
      {
        workspaceId: workspace.id,
        userId: user.id,
        action: ActivityAction.WORKSPACE_CREATED,
        entityType: 'Workspace',
        entityId: workspace.id,
        changes: { name: { old: null, new: workspace.name } },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    await logActivity(
      {
        workspaceId: workspace.id,
        userId: user.id,
        action: ActivityAction.USER_REGISTERED,
        entityType: 'User',
        entityId: user.id,
        metadata: { role: user.role },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    const tokens = await startSession(tx, user, ctx);
    return { user: toPublicUser(user), workspace: toPublicWorkspace(workspace), ...tokens };
  });
}

// The same email may belong to several workspaces. Candidates are narrowed by
// password first, so the workspace list is only disclosed to the account owner.
export async function login(input: LoginInput, ctx: ClientContext) {
  const candidates = await prisma.user.findMany({
    where: {
      email: input.email,
      deletedAt: null,
      workspace: { deletedAt: null },
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    include: { workspace: true },
  });

  if (candidates.length === 0) {
    await burnPasswordCheck(input.password);
    throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  }

  const matches: typeof candidates = [];
  for (const candidate of candidates) {
    if (await verifyPassword(input.password, candidate.passwordHash)) matches.push(candidate);
  }
  if (matches.length === 0) throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
  if (matches.length > 1) {
    throw conflict('This email belongs to several workspaces; choose one', 'WORKSPACE_SELECTION_REQUIRED', {
      workspaces: matches.map((m) => toPublicWorkspace(m.workspace)),
    });
  }

  const user = matches[0]!;
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.USER_LOGGED_IN,
        entityType: 'User',
        entityId: user.id,
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    const tokens = await startSession(tx, user, ctx);
    return { user: toPublicUser(user), workspace: toPublicWorkspace(user.workspace), ...tokens };
  });
}

// Rotation with reuse detection: every refresh token works exactly once. Seeing a
// used one again means it was stolen (or replayed), so the whole session is revoked.
export async function refresh(rawToken: string, ctx: ClientContext): Promise<IssuedTokens> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { session: { include: { user: { include: { workspace: { select: { deletedAt: true } } } } } } },
  });
  if (!stored) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');

  const { session } = stored;
  const now = new Date();

  const revokeForReuse = async () => {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
    await logActivity({
      workspaceId: session.workspaceId,
      userId: session.userId,
      action: ActivityAction.REFRESH_TOKEN_REUSE_DETECTED,
      entityType: 'Session',
      entityId: session.id,
      ipAddress: ctx.ipAddress,
    });
    logger.warn('refresh token reuse detected', { sessionId: session.id, userId: session.userId });
    await disconnectSession(session.id);
    return unauthorized('Session has ended, please sign in again', 'SESSION_REVOKED');
  };

  if (stored.usedAt) throw await revokeForReuse();
  if (session.revokedAt || session.expiresAt < now || stored.expiresAt < now) {
    throw unauthorized('Session has ended, please sign in again', 'SESSION_REVOKED');
  }
  if (session.user.deletedAt || session.user.workspace.deletedAt) {
    throw unauthorized('Account is no longer active', 'ACCOUNT_INACTIVE');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Conditional update: of two concurrent refreshes with the same token, only one wins.
    const claimed = await tx.refreshToken.updateMany({ where: { id: stored.id, usedAt: null }, data: { usedAt: now } });
    if (claimed.count === 0) return null;
    // Sliding window (Gap 4): every successful refresh pushes expiry out another 7 days.
    const expiresAt = refreshExpiry();
    await tx.session.update({ where: { id: session.id }, data: { expiresAt, lastUsedAt: now } });
    const refreshToken = await issueRefreshToken(tx, session.id, expiresAt);
    return {
      accessToken: accessTokenFor(session.user, session.id),
      refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    };
  });
  if (!result) throw await revokeForReuse();
  return result;
}

export async function logout(sessionId: string, ctx: ClientContext) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt) return;
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  await disconnectSession(sessionId);
  await logActivity({
    workspaceId: session.workspaceId,
    userId: session.userId,
    action: ActivityAction.USER_LOGGED_OUT,
    entityType: 'Session',
    entityId: session.id,
    ipAddress: ctx.ipAddress,
  });
}

export async function sessionIdForRefreshToken(rawToken: string): Promise<string | null> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    select: { sessionId: true },
  });
  return stored?.sessionId ?? null;
}

// Always succeeds from the caller's point of view so the endpoint can't be used
// to discover which emails have accounts.
export async function requestPasswordReset(email: string, ctx: ClientContext) {
  const users = await prisma.user.findMany({
    where: { email, deletedAt: null, workspace: { deletedAt: null } },
    include: { workspace: { select: { name: true } } },
  });

  for (const user of users) {
    const token = generateOpaqueToken(32);
    await prisma.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000),
        },
      });
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.PASSWORD_RESET_REQUESTED,
          entityType: 'User',
          entityId: user.id,
          ipAddress: ctx.ipAddress,
        },
        tx,
      );
    });

    const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(env.PASSWORD_RESET_TTL_SECONDS / 60);
    await sendMail({
      to: user.email,
      subject: `Restablecer contraseña — ${user.workspace.name}`,
      text:
        `Hola ${user.displayName},\n\n` +
        `Recibimos una solicitud para restablecer tu contraseña en ${user.workspace.name}.\n` +
        `Abre este enlace (válido ${minutes} minutos):\n${link}\n\n` +
        `Si no fuiste tú, ignora este correo.`,
    }).catch((error) => logger.error('password reset email failed', { userId: user.id, error }));
  }
}

export async function confirmPasswordReset(token: string, newPassword: string, ctx: ClientContext) {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  const now = new Date();
  if (!stored || stored.usedAt || stored.expiresAt < now || stored.user.deletedAt) {
    throw validationError('This reset link is invalid or has expired', [{ field: 'token', message: 'invalid' }]);
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count === 0) {
      throw validationError('This reset link is invalid or has expired', [{ field: 'token', message: 'invalid' }]);
    }
    await tx.user.update({ where: { id: stored.userId }, data: { passwordHash } });
    // A password reset signs the account out everywhere.
    await tx.session.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: now } });
    await logActivity(
      {
        workspaceId: stored.user.workspaceId,
        userId: stored.userId,
        action: ActivityAction.PASSWORD_RESET_COMPLETED,
        entityType: 'User',
        entityId: stored.userId,
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  });
  await disconnectUser(stored.userId);
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      department: { select: { id: true, name: true, slug: true, color: true } },
    },
  });
  return {
    user: toPublicUser(user),
    workspace: toPublicWorkspace(user.workspace),
    department: user.department,
  };
}
