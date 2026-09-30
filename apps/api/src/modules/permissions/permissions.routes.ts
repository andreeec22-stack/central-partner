import type { Role } from '@prisma/client';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, notFound, validationError } from '../../lib/errors';
import { invalidatePermissions } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { emitTo, rooms } from '../../lib/realtime';
import { parseJson } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import { refreshUserRooms } from '../../realtime/socket-server';
import type { AppEnv, AuthUser } from '../../types';
import { ActivityAction, logActivity } from '../audit/activity-log';
import { clientContext } from '../auth/auth.routes';

// Settings > Permisos & Roles.
//
// What each role can do is fixed in code (lib/permissions.ts) and enforced by
// the API on every request — a checkbox must never be able to, say, let a
// VIEWER write or stop the director from closing weeks. This page shows that
// matrix, and edits the two things that ARE configurable per person:
//   • which other departments a JEFE_AREA can see (read-only visibility)
//   • whether a JEFE_AREA may create tasks in their own department

interface Permission {
  key: string;
  label: string;
  granted: boolean | 'configurable';
}

const MATRIX: Record<Role, { label: string; description: string; permissions: Permission[] }> = {
  ADMIN: {
    label: 'Director (Admin)',
    description: 'Ve y gestiona todo el espacio de trabajo.',
    permissions: [
      { key: 'see_all_departments', label: 'Ver todos los departamentos', granted: true },
      { key: 'manage_users', label: 'Crear y administrar usuarios', granted: true },
      { key: 'manage_settings', label: 'Modificar configuración, marca y departamentos', granted: true },
      { key: 'create_tasks', label: 'Crear tareas en cualquier área', granted: true },
      { key: 'fill_results', label: 'Corregir KPIs y funciones cualquier día', granted: true },
      { key: 'close_weeks', label: 'Cerrar semanas', granted: true },
      { key: 'view_audit', label: 'Ver auditoría', granted: true },
    ],
  },
  JEFE_AREA: {
    label: 'Jefe de área',
    description: 'Gestiona su departamento.',
    permissions: [
      { key: 'see_own_department', label: 'Ver su departamento', granted: true },
      { key: 'update_tasks', label: 'Actualizar las tareas de su área', granted: true },
      { key: 'manage_kpis', label: 'Definir KPIs y funciones de su área', granted: true },
      { key: 'fill_results', label: 'Llenar KPIs y funciones (desde el sábado)', granted: true },
      { key: 'create_tasks', label: 'Crear tareas en su área', granted: 'configurable' },
      { key: 'see_other_departments', label: 'Ver otros departamentos (solo lectura)', granted: 'configurable' },
      { key: 'manage_users', label: 'Administrar usuarios o configuración', granted: false },
    ],
  },
  USER: {
    label: 'Colaborador',
    description: 'Trabaja las tareas que se le asignan.',
    permissions: [
      { key: 'see_own_department', label: 'Ver las tareas de su departamento', granted: true },
      { key: 'update_progress', label: 'Actualizar el avance y observación de sus tareas', granted: true },
      { key: 'comment', label: 'Comentar y adjuntar archivos', granted: true },
      { key: 'create_tasks', label: 'Crear tareas', granted: false },
      { key: 'see_all_departments', label: 'Ver todos los departamentos', granted: false },
    ],
  },
  VIEWER: {
    label: 'Lector',
    description: 'Consulta sin modificar nada.',
    permissions: [
      { key: 'view_dashboard', label: 'Ver el dashboard y las tareas de su departamento', granted: true },
      { key: 'modify', label: 'Modificar cualquier dato', granted: false },
    ],
  },
};

const ROLES: Role[] = ['ADMIN', 'JEFE_AREA', 'USER', 'VIEWER'];

async function jefeSettings(workspaceId: string) {
  const jefes = await prisma.user.findMany({
    where: { workspaceId, role: 'JEFE_AREA', deletedAt: null },
    select: {
      id: true,
      displayName: true,
      email: true,
      canCreateTasks: true,
      departmentId: true,
      department: { select: { name: true } },
      visibility: { select: { visibleDepartmentIds: true } },
    },
    orderBy: { displayName: 'asc' },
  });
  return jefes.map((j) => ({
    id: j.id,
    displayName: j.displayName,
    email: j.email,
    departmentId: j.departmentId,
    departmentName: j.department?.name ?? null,
    canCreateTasks: j.canCreateTasks,
    visibleDepartmentIds: j.visibility?.visibleDepartmentIds ?? [],
  }));
}

const jefeSchema = z
  .object({
    userId: z.string().uuid(),
    canCreateTasks: z.boolean().optional(),
    visibleDepartmentIds: z
      .array(z.string().uuid())
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate departments')
      .optional(),
  })
  .refine((v) => v.canCreateTasks !== undefined || v.visibleDepartmentIds !== undefined, 'Nothing to update');

async function updateJefe(admin: AuthUser, input: z.infer<typeof jefeSchema>, ipAddress: string) {
  const jefe = await prisma.user.findFirst({
    where: { id: input.userId, workspaceId: admin.workspaceId, role: 'JEFE_AREA', deletedAt: null },
    include: { visibility: true },
  });
  if (!jefe) throw notFound('Area head');

  // Their own department is always visible; store only the extra ones.
  const visible = input.visibleDepartmentIds?.filter((id) => id !== jefe.departmentId);
  if (visible?.length) {
    const found = await prisma.department.count({ where: { id: { in: visible }, workspaceId: admin.workspaceId, deletedAt: null } });
    if (found !== visible.length) {
      throw validationError('Some departments do not exist', [{ field: 'visibleDepartmentIds', message: 'invalid' }]);
    }
  }

  const before = { canCreateTasks: jefe.canCreateTasks, visibleDepartmentIds: jefe.visibility?.visibleDepartmentIds ?? [] };
  const after = {
    canCreateTasks: input.canCreateTasks ?? before.canCreateTasks,
    visibleDepartmentIds: visible ?? before.visibleDepartmentIds,
  };
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (after.canCreateTasks !== before.canCreateTasks) changes.canCreateTasks = { old: before.canCreateTasks, new: after.canCreateTasks };
  if ([...after.visibleDepartmentIds].sort().join() !== [...before.visibleDepartmentIds].sort().join()) {
    changes.visibleDepartmentIds = { old: before.visibleDepartmentIds, new: after.visibleDepartmentIds };
  }
  if (!Object.keys(changes).length) return;

  await prisma.$transaction(async (tx) => {
    if (changes.canCreateTasks) await tx.user.update({ where: { id: jefe.id }, data: { canCreateTasks: after.canCreateTasks } });
    if (changes.visibleDepartmentIds) {
      await tx.departmentVisibility.upsert({
        where: { jefeAreaId: jefe.id },
        update: { visibleDepartmentIds: after.visibleDepartmentIds },
        create: { workspaceId: admin.workspaceId, jefeAreaId: jefe.id, visibleDepartmentIds: after.visibleDepartmentIds },
      });
    }
    await logActivity(
      {
        workspaceId: admin.workspaceId,
        userId: admin.id,
        action: ActivityAction.PERMISSIONS_UPDATED,
        entityType: 'User',
        entityId: jefe.id,
        changes,
        metadata: { displayName: jefe.displayName },
        ipAddress,
      },
      tx,
    );
  });

  // Takes effect now: cached scope dropped, live sockets re-roomed, the jefe's
  // screens refetch what they can see and do.
  await invalidatePermissions(jefe.id);
  await refreshUserRooms(jefe.id);
  emitTo([rooms.user(jefe.id)], 'permissions:updated', { userId: jefe.id });
}

export const permissionRoutes = new Hono<AppEnv>()
  .use('*', requireAuth, requireRole('ADMIN'))
  .get('/', async (c) =>
    c.json({
      roles: ROLES.map((role) => ({ role, ...MATRIX[role] })),
      jefes: await jefeSettings(c.get('user').workspaceId),
    }),
  )
  // Only JEFE_AREA has per-person settings; the other roles are fixed by design.
  .patch('/:role', async (c) => {
    const role = c.req.param('role');
    if (role !== 'JEFE_AREA') {
      throw new AppError(422, 'ROLE_NOT_CONFIGURABLE', 'Los permisos de este rol son fijos; solo se configuran por jefe de área');
    }
    await updateJefe(c.get('user'), await parseJson(c, jefeSchema), clientContext(c).ipAddress);
    return c.json({ jefes: await jefeSettings(c.get('user').workspaceId) });
  });
