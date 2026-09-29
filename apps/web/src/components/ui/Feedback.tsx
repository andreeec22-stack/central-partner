import clsx from 'clsx';
import { CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useToasts } from '../../stores/toast';

export function Spinner({ label = 'Cargando…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={clsx('flex items-center gap-2 text-sm text-muted', className)}>
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded-md bg-sunken', className)} />;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-full bg-sunken text-ink-soft">{icon}</div>
      <h3 className="font-bold">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-sem-red/30 bg-sem-red-soft px-4 py-3 text-sm text-sem-red">
      <span className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {message}
      </span>
      {onRetry && (
        <button onClick={onRetry} className="font-semibold underline underline-offset-2">
          Reintentar
        </button>
      )}
    </div>
  );
}

const toneStyle = {
  success: { icon: CircleCheck, className: 'border-sem-green/30 text-sem-green' },
  error: { icon: TriangleAlert, className: 'border-sem-red/30 text-sem-red' },
  info: { icon: Info, className: 'border-line-strong text-ink-soft' },
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6">
      {toasts.map((t) => {
        const { icon: Icon, className } = toneStyle[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={clsx('pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border bg-surface px-4 py-3 text-sm shadow-pop', className)}
          >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="flex-1 text-ink">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="text-muted hover:text-ink" aria-label="Cerrar aviso">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
