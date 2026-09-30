import type { Server } from 'socket.io';
import { logger } from './logger';

// Socket.IO is push-only: clients mutate through REST, the server broadcasts.
// Rooms decide who receives what, mirroring the RBAC read scope:
//   ws:{workspaceId}      everyone in the workspace (branding, activity feed)
//   admins:{workspaceId}  ADMINs (see every department)
//   dept:{departmentId}   members + JEFE_AREAs granted visibility of it
//   user:{userId}         personal notifications
//   session:{sessionId}   lets logout kick that session's sockets
export const rooms = {
  workspace: (id: string) => `ws:${id}`,
  admins: (workspaceId: string) => `admins:${workspaceId}`,
  department: (id: string) => `dept:${id}`,
  user: (id: string) => `user:${id}`,
  session: (id: string) => `session:${id}`,
};

export type ServerEvent =
  | 'task:created'
  | 'task:updated'
  | 'task:progress'
  | 'task:blocked'
  | 'task:completed'
  | 'task:deleted'
  | 'tasks:imported'
  | 'comment:created'
  | 'comment:updated'
  | 'comment:deleted'
  | 'file:uploaded'
  | 'file:deleted'
  | 'notification:created'
  | 'branding:updated'
  | 'excel:processing_complete'
  | 'week:created'
  | 'week:closed'
  | 'kpi:changed'
  | 'function:changed'
  | 'task:observation'
  | 'permissions:updated';

let io: Server | null = null;

export function setRealtimeServer(server: Server | null) {
  io = server;
}

export function getRealtimeServer(): Server | null {
  return io;
}

export function emitTo(targetRooms: string[], event: ServerEvent, payload: unknown) {
  if (!io || targetRooms.length === 0) return;
  try {
    // A socket in several of these rooms still receives the event once.
    io.to(targetRooms).emit(event, payload);
  } catch (error) {
    logger.error('realtime emit failed', { event, error });
  }
}

interface TaskAudience {
  workspaceId: string;
  departmentId: string;
  assignedToId?: string | null;
}

// Everyone allowed to see the task: its department, ADMINs, and its assignee.
export function taskRooms(t: TaskAudience): string[] {
  const list = [rooms.admins(t.workspaceId), rooms.department(t.departmentId)];
  if (t.assignedToId) list.push(rooms.user(t.assignedToId));
  return list;
}

// Sends to `targetRooms` but skips sockets that are also in `exceptRooms` —
// used to tell people who just LOST access to a task that it left their view,
// without leaking its new contents.
export function emitToExcept(targetRooms: string[], exceptRooms: string[], event: ServerEvent, payload: unknown) {
  if (!io || targetRooms.length === 0) return;
  try {
    io.to(targetRooms).except(exceptRooms).emit(event, payload);
  } catch (error) {
    logger.error('realtime emit failed', { event, error });
  }
}

export async function disconnectSession(sessionId: string) {
  if (!io) return;
  io.in(rooms.session(sessionId)).disconnectSockets(true);
}

export async function disconnectUser(userId: string) {
  if (!io) return;
  io.in(rooms.user(userId)).disconnectSockets(true);
}
