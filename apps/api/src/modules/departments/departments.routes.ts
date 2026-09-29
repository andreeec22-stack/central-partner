import { Hono } from 'hono';
import { z } from 'zod';
import { conflict, notFound, validationError } from '../../lib/errors';
import { departmentFilter, departmentScope, invalidatePermissions } from '../../lib/permissions';
import { prisma, type Tx } from '../../lib/prisma';
import { rooms, emitTo } from '../../lib/realtime';
import { slugify } from '../../lib/slug';
import { idParam, parseJson } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import { refreshUserRooms } from '../../realtime/socket-server';
import type { AppEnv } from '../../types';
import { ActivityAction, diffFields, logActivity } from '../audit/activity-log';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #2563EB');

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  headId: z.string().uuid().nullable().optional(),
  color: hexColor.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const publicSelect = {
  id: true,
  name: true,
  slug: true,
  color: true,
  description: true,
  headId: true,
  head: { select: { id: true, displayName: true } },
  _count: { select: { members: { where: { deletedAt: null } } } },
} as const;

type DepartmentRow = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  headId: string | null;
  head: { id: string; displayName: string } | null;
  _count: { members: number };
};

const toPublic = ({ _count, ...d }: DepartmentRow) => ({ ...d, usersCount: _count.members });

async function assertHead(db: Tx, workspaceId: string, headId: string | null | undefined) {
  if (!headId) return;
  const head = await db.user.findFirst({ where: { id: headId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!head) throw validationError('Department head must be an active user of this workspace', [{ field: 'headId', message: 'invalid' }]);
}

async function uniqueSlug(db: Tx, workspaceId: string, name: string, excludeId?: string) {
  const base = slugify(name) || 'departamento';
  const taken = new Set(
    (
      await db.department.findMany({
        where: { workspaceId, slug: { startsWith: base }, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { slug: true },
      })
    ).map((d) => d.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

async function assertNameFree(db: Tx, workspaceId: string, name: string, excludeId?: string) {
  const clash = await db.department.findFirst({
    where: { workspaceId, deletedAt: null, name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (clash) throw conflict(`A department named "${name}" already exists`);
}

export const departmentRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  // Only departments the caller can see (sidebar, filters and pickers follow this).
  .get('/', async (c) => {
    const user = c.get('user');
    const scope = await departmentScope(user);
    const departments = await prisma.department.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, id: departmentFilter(scope) },
      select: publicSelect,
      orderBy: { name: 'asc' },
    });
    return c.json({ data: departments.map(toPublic) });
  })

  .post('/', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    const input = await parseJson(c, createSchema);
    const department = await prisma.$transaction(async (tx) => {
      await assertNameFree(tx, user.workspaceId, input.name);
      await assertHead(tx, user.workspaceId, input.headId);
      const created = await tx.department.create({
        data: {
          workspaceId: user.workspaceId,
          name: input.name,
          slug: await uniqueSlug(tx, user.workspaceId, input.name),
          headId: input.headId ?? null,
          color: input.color ?? null,
          description: input.description ?? null,
        },
        select: publicSelect,
      });
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.DEPARTMENT_CREATED,
          entityType: 'Department',
          entityId: created.id,
          changes: { name: { old: null, new: created.name }, headId: { old: null, new: created.headId } },
          ipAddress: c.get('clientIp'),
        },
        tx,
      );
      return created;
    });
    return c.json({ department: toPublic(department) }, 201);
  })

  .patch('/:id', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    const id = idParam(c, 'id', 'Department');
    const input = await parseJson(c, updateSchema);
    const department = await prisma.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
      if (!existing) throw notFound('Department');
      if (input.name) await assertNameFree(tx, user.workspaceId, input.name, id);
      await assertHead(tx, user.workspaceId, input.headId);
      const data = {
        ...input,
        ...(input.name && input.name !== existing.name ? { slug: await uniqueSlug(tx, user.workspaceId, input.name, id) } : {}),
      };
      const updated = await tx.department.update({ where: { id }, data, select: publicSelect });
      const changes = diffFields(existing as unknown as Record<string, unknown>, data);
      if (Object.keys(changes).length) {
        await logActivity(
          {
            workspaceId: user.workspaceId,
            userId: user.id,
            action: ActivityAction.DEPARTMENT_UPDATED,
            entityType: 'Department',
            entityId: id,
            changes,
            ipAddress: c.get('clientIp'),
          },
          tx,
        );
      }
      return updated;
    });
    return c.json({ department: toPublic(department) });
  })

  // Soft delete. Refused while the department still has active tasks, so no
  // task is ever orphaned; members are unassigned (they keep their accounts).
  .delete('/:id', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    const id = idParam(c, 'id', 'Department');
    const memberIds = await prisma.$transaction(async (tx) => {
      const existing = await tx.department.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
      if (!existing) throw notFound('Department');
      const activeTasks = await tx.task.count({ where: { departmentId: id, deletedAt: null } });
      if (activeTasks > 0) {
        throw conflict(`Department still has ${activeTasks} active task(s); move or delete them first`, 'DEPARTMENT_NOT_EMPTY', {
          activeTasks,
        });
      }
      const members = await tx.user.findMany({ where: { departmentId: id }, select: { id: true } });
      await tx.user.updateMany({ where: { departmentId: id }, data: { departmentId: null } });
      await tx.department.update({ where: { id }, data: { deletedAt: new Date(), headId: null } });
      // Drop the department from every JEFE_AREA visibility grant.
      const grants = await tx.departmentVisibility.findMany({
        where: { workspaceId: user.workspaceId, visibleDepartmentIds: { has: id } },
      });
      for (const grant of grants) {
        await tx.departmentVisibility.update({
          where: { id: grant.id },
          data: { visibleDepartmentIds: grant.visibleDepartmentIds.filter((d) => d !== id) },
        });
      }
      await logActivity(
        {
          workspaceId: user.workspaceId,
          userId: user.id,
          action: ActivityAction.DEPARTMENT_DELETED,
          entityType: 'Department',
          entityId: id,
          metadata: { name: existing.name, unassignedMembers: members.length },
          ipAddress: c.get('clientIp'),
        },
        tx,
      );
      return [...members.map((m) => m.id), ...grants.map((g) => g.jefeAreaId)];
    });
    await invalidatePermissions(...memberIds);
    await Promise.all(memberIds.map(refreshUserRooms));
    emitTo([rooms.workspace(user.workspaceId)], 'permissions:updated', { departmentDeleted: id });
    return c.json({ success: true });
  });
