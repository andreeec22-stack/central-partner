import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { isValidTimeZone } from '../../lib/time';
import { parseJson } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv, AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import { clientContext } from '../auth/auth.routes';
import { emailSchema } from '../auth/auth.schemas';
import { presentBranding } from '../branding/branding.service';

// Settings > Workspace: the company's name, contact email, primary color and
// timezone in one place. The logo is uploaded through the branding endpoint.

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #3182CE');

const updateSchema = z
  .object({
    name: z.string().trim().min(1, 'The name is required').max(50),
    contactEmail: emailSchema.nullable(),
    timezone: z.string().max(50).refine(isValidTimeZone, 'Unknown timezone'),
    primaryColor: hexColor,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

async function load(workspaceId: string) {
  const ws = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: { branding: true },
  });
  const branding = ws.branding ?? (await prisma.workspaceBranding.create({ data: { workspaceId } }));
  return { ws, branding };
}

function present({ ws, branding }: Awaited<ReturnType<typeof load>>) {
  return {
    id: ws.id,
    name: branding.workspaceName,
    slug: ws.slug,
    contactEmail: ws.contactEmail,
    timezone: ws.timezone,
    primaryColor: branding.colorPrimary,
    logoUrl: branding.logoUrl,
    updatedAt: ws.updatedAt > branding.updatedAt ? ws.updatedAt : branding.updatedAt,
  };
}

async function update(user: AuthUser, input: z.infer<typeof updateSchema>, ipAddress: string) {
  const before = await load(user.workspaceId);
  const current = present(before);
  const changes = diffFields(current as unknown as Record<string, unknown>, {
    ...input,
    ...(input.primaryColor ? { primaryColor: input.primaryColor.toUpperCase() } : {}),
  });
  if (!Object.keys(changes).length) return current;

  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: user.workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });
    if (input.name !== undefined || input.primaryColor !== undefined) {
      await tx.workspaceBranding.update({
        where: { workspaceId: user.workspaceId },
        data: {
          ...(input.name !== undefined ? { workspaceName: input.name } : {}),
          ...(input.primaryColor !== undefined ? { colorPrimary: input.primaryColor.toUpperCase() } : {}),
        },
      });
    }
    await logActivity(
      {
        workspaceId: user.workspaceId,
        userId: user.id,
        action: ActivityAction.WORKSPACE_SETTINGS_UPDATED,
        entityType: 'Workspace',
        entityId: user.workspaceId,
        changes,
        ipAddress,
      },
      tx,
    );
  });

  const after = await load(user.workspaceId);
  // Name and color are part of the branding every client renders.
  if (changes.name || changes.primaryColor) {
    emitTo([rooms.workspace(user.workspaceId)], 'branding:updated', { branding: presentBranding(after.branding) });
  }
  return present(after);
}

export const workspaceRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => c.json({ workspace: present(await load(c.get('user').workspaceId)) }))
  .patch('/', requireRole('ADMIN'), async (c) => {
    const input = await parseJson(c, updateSchema);
    return c.json({ workspace: await update(c.get('user'), input, clientContext(c).ipAddress) });
  });
