import type { Role } from '@prisma/client';
import { hashPassword } from '../../src/lib/password';
import { prisma } from '../../src/lib/prisma';
import { startSession } from '../../src/modules/auth/auth.service';
import { call } from './helpers';

export interface Actor {
  id: string;
  token: string;
  role: Role;
  departmentId: string | null;
}

let passwordHash: string | undefined;

async function createUser(workspaceId: string, email: string, role: Role, departmentId: string | null): Promise<Actor> {
  passwordHash ??= await hashPassword('secreto-123');
  const user = await prisma.user.create({
    data: {
      workspaceId,
      email,
      passwordHash,
      displayName: email.split('@')[0]!,
      role,
      departmentId,
      notificationPrefs: { create: { workspaceId } },
    },
  });
  const { accessToken } = await startSession(prisma, user, { ipAddress: '127.0.0.1' });
  return { id: user.id, token: accessToken, role, departmentId };
}

// Director (ADMIN) + two departments, each with a JEFE_AREA, a USER and a VIEWER.
export async function seedWorkspace() {
  const reg = await call('POST', '/api/v1/auth/register', {
    body: { email: 'director@empresa.com', password: 'secreto-123', workspaceName: 'Central Partner' },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const workspaceId: string = reg.body.workspace.id;
  const admin: Actor = { id: reg.body.user.id, token: reg.body.accessToken, role: 'ADMIN', departmentId: null };

  const mkDept = async (name: string) => {
    const res = await call('POST', '/api/v1/departments', { token: admin.token, body: { name } });
    if (res.status !== 201) throw new Error(`department failed: ${JSON.stringify(res.body)}`);
    return res.body.department.id as string;
  };
  const marketing = await mkDept('Marketing');
  const finanzas = await mkDept('Finanzas');

  return {
    workspaceId,
    admin,
    marketing,
    finanzas,
    mkt: {
      jefe: await createUser(workspaceId, 'jefe.mkt@empresa.com', 'JEFE_AREA', marketing),
      user: await createUser(workspaceId, 'ana.mkt@empresa.com', 'USER', marketing),
      user2: await createUser(workspaceId, 'luis.mkt@empresa.com', 'USER', marketing),
      viewer: await createUser(workspaceId, 'lector.mkt@empresa.com', 'VIEWER', marketing),
    },
    fin: {
      jefe: await createUser(workspaceId, 'jefe.fin@empresa.com', 'JEFE_AREA', finanzas),
      user: await createUser(workspaceId, 'carla.fin@empresa.com', 'USER', finanzas),
    },
  };
}

export type Seed = Awaited<ReturnType<typeof seedWorkspace>>;

export async function createTask(token: string, body: Record<string, unknown>) {
  const res = await call('POST', '/api/v1/tasks', { token, body });
  if (res.status !== 201) throw new Error(`task create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.task as { id: string; [k: string]: any };
}
