import clsx from 'clsx';

export type SemaphoreType = 'green' | 'yellow' | 'red' | 'gray';

// Fixed colors, never branded. The emoji is decorative; the label carries the
// meaning for screen readers (and for color-blind users via the tooltip).
const style: Record<SemaphoreType, { emoji: string; tone: string; label: string }> = {
  green: { emoji: '🟢', tone: 'bg-sem-green-soft', label: 'En meta' },
  yellow: { emoji: '🟡', tone: 'bg-sem-yellow-soft', label: 'En riesgo' },
  red: { emoji: '🔴', tone: 'bg-sem-red-soft', label: 'Crítico' },
  gray: { emoji: '⚪', tone: 'bg-sunken', label: 'Sin datos aún' },
};

const sizes = {
  sm: 'size-7 text-sm',
  md: 'size-9 text-lg',
  lg: 'size-11 text-2xl',
};

interface SemaphoreIconProps {
  type: SemaphoreType;
  size?: 'sm' | 'md' | 'lg';
  // Overrides the default reading ("En meta"…), e.g. "Vence hoy" for tasks.
  label?: string;
  className?: string;
}

export function SemaphoreIcon({ type, size = 'md', label, className }: SemaphoreIconProps) {
  const s = style[type];
  const text = label ?? s.label;
  return (
    <span role="img" aria-label={text} title={text} className={clsx('inline-grid shrink-0 place-items-center rounded-lg leading-none', s.tone, sizes[size], className)}>
      <span aria-hidden>{s.emoji}</span>
    </span>
  );
}

// API semaphores are upper-case and null when there is nothing to measure yet.
export function toSemaphoreType(value: string | null | undefined): SemaphoreType {
  return value === 'GREEN' ? 'green' : value === 'YELLOW' ? 'yellow' : value === 'RED' ? 'red' : 'gray';
}

// ≥90 green · 70–89 yellow · <70 red · no value gray (the director's thresholds).
export function semaphoreForPercent(percent: number | null | undefined): SemaphoreType {
  if (percent === null || percent === undefined) return 'gray';
  if (percent >= 90) return 'green';
  if (percent >= 70) return 'yellow';
  return 'red';
}
