import type { Role } from '@prisma/client';
import { createMiddleware } from 'hono/factory';
import { forbidden, unauthorized } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { verifyAccessToken } from '../lib/tokens';
import type { AppEnv, AuthUser } from '../types';

// Verifies the JWT, then re-reads user + session from the DB so that role
// changes, deactivation and logout take effect immediately rather than when the
// token expires. Both lookups are by primary key. Shared by HTTP and Socket.IO.
export async function authenticateAccessToken(token: string): Promise<AuthUser> {
  const claims = verifyAccessToken(token);
  if (!claims) throw unauthorized('Invalid or expired access token', 'TOKEN_INVALID');

  const [user, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        workspaceId: true,
        role: true,
        canCreateTasks: true,
        departmentId: true,
        email: true,
        displayName: true,
        timezone: true,
        deletedAt: true,
        workspace: { select: { deletedAt: true, timezone: true } },
      },
    }),
    prisma.session.findUnique({
      where: { id: claims.sid },
      select: { userId: true, revokedAt: true, expiresAt: true },
    }),
  ]);

  if (!user || user.deletedAt || user.workspace.deletedAt || user.workspaceId !== claims.wid) {
    throw unauthorized('Account is no longer active', 'ACCOUNT_INACTIVE');
  }
  if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized('Session has ended, please sign in again', 'SESSION_REVOKED');
  }

  return {
    id: user.id,
    workspaceId: user.workspaceId,
    sessionId: claims.sid,
    role: user.role,
    canCreateTasks: user.canCreateTasks,
    departmentId: user.departmentId,
    email: user.email,
    displayName: user.displayName,
    timezone: user.timezone,
    workspaceTimezone: user.workspace.timezone,
  };
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!token) throw unauthorized();
  c.set('user', await authenticateAccessToken(token));
  await next();
});

export const requireRole = (...roles: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!roles.includes(c.get('user').role)) throw forbidden();
    await next();
  });
