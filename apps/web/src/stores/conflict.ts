import { create } from 'zustand';

// An edit refused because someone else saved the same task first
// (409 TASK_CONFLICT). One dialog for the whole app (see ConflictDialog).
interface ConflictState {
  taskId: string | null;
  message: string | null;
  show: (taskId: string, message: string) => void;
  dismiss: () => void;
}

export const useConflict = create<ConflictState>((set) => ({
  taskId: null,
  message: null,
  show: (taskId, message) => set({ taskId, message }),
  dismiss: () => set({ taskId: null, message: null }),
}));
