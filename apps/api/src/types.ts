import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  workspaceId: string;
  sessionId: string;
  role: Role;
  departmentId: string | null;
  email: string;
  displayName: string;
  timezone: string;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    clientIp: string;
    user: AuthUser;
  };
}
