import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Native <dialog> + showModal(): focus trapping, Esc to close and the inert
// background come from the browser.
export function Dialog({ open, onClose, title, description, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal() focuses the first focusable element (the close button);
      // form dialogs should start in their first field instead.
      el.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]), textarea, select')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-pop"
      aria-labelledby="dialog-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-bold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-sunken hover:text-ink" aria-label="Cerrar">
              <X className="size-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line bg-paper/60 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
