import { Hono } from 'hono';
import { z } from 'zod';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { authLimiter, clientContext } from '../auth/auth.routes';
import { setRefreshCookie } from '../auth/cookies';
import { forbidden } from '../../lib/errors';
import { acceptInviteSchema, inviteSchema, listUsersSchema, updateProfileSchema, updateUserSchema } from './users.schemas';
import * as users from './users.service';

const tokenQuery = z.object({ token: z.string().min(1).max(200) });

// Public: invitation acceptance (token-validated).
export const publicUserRoutes = new Hono<AppEnv>()
  .get('/accept-invite', authLimiter('invite:lookup'), async (c) => {
    const { token } = parseQuery(c, tokenQuery);
    return c.json(await users.describeInvitation(token));
  })
  .post('/accept-invite', authLimiter('invite:accept'), async (c) => {
    const input = await parseJson(c, acceptInviteSchema);
    const result = await users.acceptInvitation(input, clientContext(c));
    setRefreshCookie(c, result.refreshToken);
    return c.json(result, 201);
  });

export const userRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => c.json(await users.listUsers(c.get('user'), parseQuery(c, listUsersSchema))))

  .post('/invite', requireRole('ADMIN'), async (c) => {
    const input = await parseJson(c, inviteSchema);
    return c.json(await users.inviteUser(c.get('user'), input, clientContext(c)), 201);
  })
  // "Nuevo usuario" = an invitation: the person sets their own password.
  .post('/', requireRole('ADMIN'), async (c) => {
    const input = await parseJson(c, inviteSchema);
    return c.json(await users.inviteUser(c.get('user'), input, clientContext(c)), 201);
  })
  .get('/invitations', requireRole('ADMIN'), async (c) => c.json(await users.listPendingInvitations(c.get('user'))))
  .delete('/invitations/:id', requireRole('ADMIN'), async (c) => {
    await users.revokeInvitation(c.get('user'), idParam(c, 'id', 'Invitation'));
    return c.json({ success: true });
  })

  // Self-service profile: never role, department or task permissions.
  .patch('/:id/profile', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === 'object' && ['role', 'departmentId', 'canCreateTasks'].some((k) => k in body)) {
      throw forbidden('Only an administrator can change role, department or task permissions');
    }
    const input = await parseJson(c, updateProfileSchema);
    return c.json(await users.updateProfile(c.get('user'), idParam(c, 'id', 'User'), input, clientContext(c)));
  })

  .patch('/:id', requireRole('ADMIN'), async (c) => {
    const input = await parseJson(c, updateUserSchema);
    return c.json(await users.updateUser(c.get('user'), idParam(c, 'id', 'User'), input, clientContext(c)));
  })
  .delete('/:id', requireRole('ADMIN'), async (c) => {
    await users.deleteUser(c.get('user'), idParam(c, 'id', 'User'), clientContext(c));
    return c.json({ success: true });
  })
  .post('/:id/restore', requireRole('ADMIN'), async (c) =>
    c.json(await users.restoreUser(c.get('user'), idParam(c, 'id', 'User'), clientContext(c))),
  )
  .get('/:id/notification-preferences', async (c) =>
    c.json(await users.getNotificationPreferences(c.get('user'), idParam(c, 'id', 'User'))),
  );
