import clsx from 'clsx';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const control =
  'w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-muted transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-sunken disabled:text-muted';

interface FieldProps {
  label: string;
  error?: string;
  hint?: ReactNode;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      {children(id, describedBy)}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-sem-red">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={clsx(control, 'h-10', invalid ? 'border-sem-red' : 'border-line-strong', className)}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className, invalid, ...rest }, ref) {
    return (
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={clsx(control, 'h-10 pr-8', invalid ? 'border-sem-red' : 'border-line-strong', className)}
        {...rest}
      />
    );
  },
);

export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={clsx(control, 'min-h-20 py-2', invalid ? 'border-sem-red' : 'border-line-strong', className)}
      {...rest}
    />
  );
}
