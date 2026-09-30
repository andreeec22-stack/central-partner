import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  workspaceId: string;
  sessionId: string;
  role: Role;
  canCreateTasks: boolean;
  departmentId: string | null;
  email: string;
  displayName: string;
  timezone: string;
  // Defines weeks and "today" for the weekly cycle.
  workspaceTimezone: string;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    clientIp: string;
    user: AuthUser;
  };
}
