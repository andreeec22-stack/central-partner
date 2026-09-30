import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { useEffect, useState } from 'react';
import { refreshAccessToken } from './api';
import { useAuth } from '../stores/auth';
import { toast } from '../stores/toast';
import type { Branding } from './types';

export type ConnectionState = 'connecting' | 'live' | 'offline';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined; // same origin in dev

const TASK_EVENTS = ['task:created', 'task:updated', 'task:progress', 'task:blocked', 'task:completed', 'task:deleted', 'tasks:imported'];
// Weekly cycle: KPIs, functions and week open/close change the index.
const WEEK_EVENTS = ['kpi:changed', 'function:changed', 'week:created', 'week:closed', 'task:observation'];
// Detail-panel events: refresh that task's panel (and the list's comment/file counts).
const DETAIL_EVENTS = ['comment:created', 'comment:updated', 'comment:deleted', 'file:uploaded', 'file:deleted'];

// One socket per signed-in session. Server events never carry instructions for
// the cache — they just mark the affected queries stale, and TanStack Query
// refetches what's on screen. Bursts (bulk updates) collapse into one refetch.
export function useRealtime(): ConnectionState {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.user?.id);
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!userId) return;

    const socket: Socket = io(SOCKET_URL, {
      transports: ['websocket'],
      // Called on every (re)connect, so a reconnect after token refresh uses the new token.
      auth: (cb) => cb({ token: useAuth.getState().accessToken }),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stale = new Set<string>();
    const invalidate = (...roots: string[]) => {
      roots.forEach((r) => stale.add(r));
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const root of stale) void qc.invalidateQueries({ queryKey: [root] });
        stale.clear();
      }, 200);
    };

    socket.on('connect', () => setState('live'));
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', async (err) => {
      setState('offline');
      // Expired access token: refresh, and socket.io's auto-reconnect picks it up.
      if (err.message === 'TOKEN_INVALID' || err.message === 'SESSION_REVOKED') {
        const token = await refreshAccessToken();
        if (token) socket.connect();
      }
    });
    // Missed events while disconnected are unknowable: refetch everything on screen.
    socket.io.on('reconnect', () => invalidate('tasks', 'dashboard', 'task', 'branding'));

    for (const event of TASK_EVENTS) {
      socket.on(event, (payload?: { taskId?: string }) => {
        invalidate('tasks', 'dashboard');
        if (payload?.taskId) void qc.invalidateQueries({ queryKey: ['task', payload.taskId], exact: true });
      });
    }
    for (const event of WEEK_EVENTS) socket.on(event, () => invalidate('dashboard', 'tasks'));
    for (const event of DETAIL_EVENTS) {
      socket.on(event, (payload: { taskId: string }) => {
        void qc.invalidateQueries({ queryKey: ['task', payload.taskId], exact: true });
        invalidate('tasks');
      });
    }
    // Branding changes apply everywhere at once (colors, name, logo).
    socket.on('branding:updated', ({ branding }: { branding: Branding }) => {
      qc.setQueryData(['branding', branding.workspaceId], branding);
    });
    socket.on('notification:created', ({ notification }: { notification: { title: string } }) => {
      toast.info(notification.title);
      invalidate('notifications');
    });
    // Surveys and reviews: lists, dashboard and the open survey refetch.
    socket.on('survey:changed', () => invalidate('surveys', 'reviews'));
    socket.on('review:changed', () => invalidate('reviews', 'surveys'));
    socket.on('permissions:updated', () => {
      void useAuth.getState().refreshMe();
      invalidate('tasks', 'dashboard', 'departments', 'users');
    });

    return () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [userId, qc]);

  return state;
}
