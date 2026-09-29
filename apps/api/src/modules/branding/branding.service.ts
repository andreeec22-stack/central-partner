import type { WorkspaceBranding } from '@prisma/client';
import { env } from '../../config/env';
import { notFound, validationError } from '../../lib/errors';
import { extensionOf, isSafeSvg } from '../../lib/file-types';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { getStorage } from '../../lib/storage';
import type { Upload } from '../../lib/upload';
import type { AuthUser } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';
import type { ClientContext } from '../auth/auth.service';
import type { UpdateBrandingInput } from './branding.schemas';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function presentBranding(b: WorkspaceBranding) {
  return {
    workspaceId: b.workspaceId,
    workspaceName: b.workspaceName,
    tagline: b.tagline,
    logoUrl: b.logoUrl,
    colors: { primary: b.colorPrimary, success: b.colorSuccess, warning: b.colorWarning, danger: b.colorDanger },
    updatedAt: b.updatedAt,
  };
}

// A workspace id other than your own is simply not found.
function assertOwnWorkspace(user: AuthUser, workspaceId: string) {
  if (workspaceId !== user.workspaceId) throw notFound('Workspace');
}

async function loadBranding(workspaceId: string) {
  return prisma.workspaceBranding.upsert({ where: { workspaceId }, update: {}, create: { workspaceId } });
}

function broadcast(b: WorkspaceBranding) {
  emitTo([rooms.workspace(b.workspaceId)], 'branding:updated', { branding: presentBranding(b) });
}

export async function getBranding(user: AuthUser, workspaceId: string) {
  assertOwnWorkspace(user, workspaceId);
  return { branding: presentBranding(await loadBranding(workspaceId)) };
}

// Last write wins (Gap 2): concurrent edits don't conflict, the later one sticks
// and every client converges through the branding:updated broadcast.
export async function updateBranding(user: AuthUser, workspaceId: string, input: UpdateBrandingInput, ctx: ClientContext) {
  assertOwnWorkspace(user, workspaceId);
  const before = await loadBranding(workspaceId);
  const data = {
    ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
    ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
    ...(input.colors?.primary ? { colorPrimary: input.colors.primary.toUpperCase() } : {}),
    ...(input.colors?.success ? { colorSuccess: input.colors.success.toUpperCase() } : {}),
    ...(input.colors?.warning ? { colorWarning: input.colors.warning.toUpperCase() } : {}),
    ...(input.colors?.danger ? { colorDanger: input.colors.danger.toUpperCase() } : {}),
  };
  const changes = diffFields(before as unknown as Record<string, unknown>, data);
  if (!Object.keys(changes).length) return { branding: presentBranding(before) };

  const after = await prisma.$transaction(async (tx) => {
    const after = await tx.workspaceBranding.update({ where: { workspaceId }, data });
    // The workspace's own name follows its display name (sidebar, emails).
    if (data.workspaceName) await tx.workspace.update({ where: { id: workspaceId }, data: { name: data.workspaceName } });
    await logActivity(
      { workspaceId, userId: user.id, action: ActivityAction.BRANDING_UPDATED, entityType: 'WorkspaceBranding', entityId: after.id, changes, ipAddress: ctx.ipAddress },
      tx,
    );
    return after;
  });
  broadcast(after);
  return { branding: presentBranding(after) };
}

// Every upload gets a new key (the old logo stays as history) and a new
// cache-busting URL, so browsers never show a stale logo.
export async function uploadLogo(user: AuthUser, workspaceId: string, upload: Upload, ctx: ClientContext) {
  assertOwnWorkspace(user, workspaceId);
  if (upload.mimeType === 'image/svg+xml' && !isSafeSvg(new TextDecoder().decode(upload.bytes))) {
    throw validationError('This SVG contains scripts or external references; export it as a plain SVG or PNG', [
      { field: 'file', message: 'unsafe svg' },
    ]);
  }
  const before = await loadBranding(workspaceId);
  const ext = extensionOf(upload.name) === 'jpeg' ? 'jpg' : extensionOf(upload.name);
  const version = Date.now();
  const logoKey = `workspaces/${workspaceId}/branding/logo-${version}.${ext}`;
  await getStorage().put(logoKey, upload.bytes, upload.mimeType);
  const logoUrl = `${env.API_PUBLIC_URL}/api/v1/public/workspaces/${workspaceId}/logo?v=${version}`;

  const after = await prisma.$transaction(async (tx) => {
    const after = await tx.workspaceBranding.update({ where: { workspaceId }, data: { logoKey, logoUrl } });
    await logActivity(
      {
        workspaceId,
        userId: user.id,
        action: ActivityAction.BRANDING_LOGO_UPDATED,
        entityType: 'WorkspaceBranding',
        entityId: after.id,
        changes: { logoUrl: { old: before.logoUrl, new: logoUrl } },
        metadata: { previousLogoKey: before.logoKey, sizeBytes: upload.size, mimeType: upload.mimeType },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return after;
  });
  broadcast(after);
  return { logoUrl, logoId: logoKey, branding: presentBranding(after) };
}

export async function removeLogo(user: AuthUser, workspaceId: string, ctx: ClientContext) {
  assertOwnWorkspace(user, workspaceId);
  const before = await loadBranding(workspaceId);
  if (!before.logoKey) return { branding: presentBranding(before) };
  const after = await prisma.$transaction(async (tx) => {
    const after = await tx.workspaceBranding.update({ where: { workspaceId }, data: { logoKey: null, logoUrl: null } });
    await logActivity(
      {
        workspaceId,
        userId: user.id,
        action: ActivityAction.BRANDING_LOGO_UPDATED,
        entityType: 'WorkspaceBranding',
        entityId: after.id,
        changes: { logoUrl: { old: before.logoUrl, new: null } },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
    return after;
  });
  broadcast(after);
  return { branding: presentBranding(after) };
}

// For the public logo route: <img> tags can't send a bearer token.
export async function findLogo(workspaceId: string) {
  const b = await prisma.workspaceBranding.findFirst({
    where: { workspaceId, workspace: { deletedAt: null } },
    select: { logoKey: true },
  });
  return b?.logoKey ?? null;
}
