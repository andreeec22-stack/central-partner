import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export const AUTO_SAVE_INTERVAL_MS = 30_000;

// Collects changes and saves them in the background: at most `intervalMs`
// after the first unsaved change (30 s by default), on flush() (explicit
// "Guardar", before submitting) and when the component unmounts. A later
// change to the same key replaces the earlier one. A failed save never throws
// at the user: the changes are kept and retried on the next round.
export function useAutoSave<T>(
  save: (changes: T[]) => Promise<unknown>,
  keyOf: (change: T) => string,
  intervalMs = AUTO_SAVE_INTERVAL_MS,
) {
  const pending = useRef(new Map<string, T>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, intervalMs);
  }, [intervalMs]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    if (pending.current.size === 0) return true;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const batch = new Map(pending.current);
    pending.current.clear();
    setStatus('saving');
    const run = (async () => {
      try {
        await saveRef.current([...batch.values()]);
        setLastSavedAt(new Date());
        if (pending.current.size) {
          setStatus('pending');
          schedule();
        } else setStatus('saved');
        return true;
      } catch {
        // Keep what failed unless it was edited again meanwhile.
        for (const [k, v] of batch) if (!pending.current.has(k)) pending.current.set(k, v);
        setStatus('error');
        schedule();
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    return ok;
  }, [schedule]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const queue = useCallback(
    (change: T) => {
      pending.current.set(keyRef.current(change), change);
      setStatus('pending');
      schedule();
    },
    [schedule],
  );

  // Leaving the page: try to keep what was typed, and warn if something is unsaved.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (timer.current) clearTimeout(timer.current);
      if (pending.current.size) void saveRef.current([...pending.current.values()]).catch(() => undefined);
    };
  }, []);

  return { queue, flush, status, lastSavedAt, hasPending: () => pending.current.size > 0 };
}
