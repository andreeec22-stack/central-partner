import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:brightness-110 shadow-card',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken',
  ghost: 'text-ink-soft hover:bg-sunken hover:text-ink',
  danger: 'bg-sem-red text-white hover:brightness-110',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
};

export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }: Props) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-55',
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
