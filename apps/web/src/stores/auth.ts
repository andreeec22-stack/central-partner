import { create } from 'zustand';
import { api, configureApi, refreshAccessToken } from '../lib/api';
import type { AuthPayload, User, Workspace } from '../lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: Status;
  accessToken: string | null;
  user: User | null;
  workspace: Workspace | null;
  bootstrap: () => Promise<void>;
  signIn: (payload: AuthPayload) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  workspace: null,

  // On page load there is no access token in memory; the refresh cookie (if
  // any) gets us a new one, then /auth/me tells us who we are.
  async bootstrap() {
    const token = await refreshAccessToken();
    if (!token) {
      set({ status: 'anonymous', accessToken: null, user: null, workspace: null });
      return;
    }
    try {
      await get().refreshMe();
    } catch {
      set({ status: 'anonymous', accessToken: null, user: null, workspace: null });
    }
  },

  signIn(payload) {
    set({ status: 'authenticated', accessToken: payload.accessToken, user: payload.user, workspace: payload.workspace });
  },

  async refreshMe() {
    const me = await api<{ user: User; workspace: Workspace }>('/auth/me');
    set({ status: 'authenticated', user: me.user, workspace: me.workspace });
  },

  async logout() {
    try {
      await api('/auth/logout', { method: 'POST', skipAuthRetry: true });
    } finally {
      set({ status: 'anonymous', accessToken: null, user: null, workspace: null });
    }
  },
}));

configureApi({
  getToken: () => useAuth.getState().accessToken,
  setToken: (accessToken) => useAuth.setState({ accessToken }),
  onSessionExpired: () => useAuth.setState({ status: 'anonymous', accessToken: null, user: null, workspace: null }),
});
