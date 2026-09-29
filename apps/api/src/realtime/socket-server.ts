import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { departmentScope } from '../lib/permissions';
import { prisma } from '../lib/prisma';
import { getRealtimeServer, rooms, setRealtimeServer } from '../lib/realtime';
import { authenticateAccessToken } from '../middleware/auth';
import type { AuthUser } from '../types';

interface SocketData {
  user: AuthUser;
}

async function departmentRoomsFor(user: AuthUser): Promise<string[]> {
  const scope = await departmentScope(user);
  if (scope.all) return []; // ADMINs get everything through the admins room
  return scope.departmentIds.map(rooms.department);
}

async function joinRooms(socket: Socket<any, any, any, SocketData>) {
  const { user } = socket.data;
  const base = [rooms.workspace(user.workspaceId), rooms.user(user.id), rooms.session(user.sessionId)];
  if (user.role === 'ADMIN') base.push(rooms.admins(user.workspaceId));
  await socket.join([...base, ...(await departmentRoomsFor(user))]);
}

// Re-evaluates room membership for every live socket of a user (role,
// department or visibility changed). Works across instances via the adapter.
export async function refreshUserRooms(userId: string) {
  const io = getRealtimeServer();
  if (!io) return;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, workspaceId: true, role: true, departmentId: true },
  });
  const sockets = await io.in(rooms.user(userId)).fetchSockets();
  for (const socket of sockets) {
    const stale = [...socket.rooms].filter((r) => r.startsWith('dept:') || r.startsWith('admins:'));
    for (const room of stale) socket.leave(room);
    if (!user) continue;
    const next = await departmentRoomsFor({ ...(socket.data as SocketData).user, ...user });
    if (user.role === 'ADMIN') next.push(rooms.admins(user.workspaceId));
    socket.join(next);
    (socket.data as SocketData).user = { ...(socket.data as SocketData).user, ...user };
  }
}

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server<any, any, any, SocketData>(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    // Connection-state recovery replays missed events after short disconnects.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  if (env.REDIS_URL) {
    const pub = new Redis(env.REDIS_URL, { lazyConnect: false });
    const sub = pub.duplicate();
    pub.on('error', (error) => logger.warn('socket redis pub error', { error }));
    sub.on('error', (error) => logger.warn('socket redis sub error', { error }));
    io.adapter(createAdapter(pub, sub));
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) return next(new Error('UNAUTHORIZED'));
    try {
      socket.data.user = await authenticateAccessToken(token);
      next();
    } catch (err) {
      next(new Error(err instanceof AppError ? err.code : 'UNAUTHORIZED'));
    }
  });

  io.on('connection', async (socket) => {
    try {
      await joinRooms(socket);
      socket.emit('ready', { userId: socket.data.user.id });
    } catch (error) {
      logger.error('socket join failed', { error, userId: socket.data.user?.id });
      socket.disconnect(true);
    }
  });

  setRealtimeServer(io);
  return io;
}
