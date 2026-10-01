import clsx from 'clsx';
import { formatPercent } from '../../lib/format';
import type { OkrLevel, OkrStatus } from '../../lib/okrs';

export const OKR_STATUS_LABEL: Record<OkrStatus, string> = {
  ON_TRACK: 'En curso',
  AT_RISK: 'En riesgo',
  OFF_TRACK: 'Fuera de curso',
  COMPLETED: 'Completado',
};

export const OKR_LEVEL_LABEL: Record<OkrLevel, string> = { COMPANY: 'Empresa', AREA: 'Área', PERSON: 'Personal' };

const statusTone: Record<OkrStatus, { pill: string; bar: string }> = {
  ON_TRACK: { pill: 'bg-sem-green-soft text-sem-green', bar: 'bg-sem-green' },
  AT_RISK: { pill: 'bg-sem-yellow-soft text-ink', bar: 'bg-sem-yellow' },
  OFF_TRACK: { pill: 'bg-sem-red-soft text-sem-red', bar: 'bg-sem-red' },
  COMPLETED: { pill: 'bg-brand/10 text-brand', bar: 'bg-brand' },
};

export function OkrStatusBadge({ status }: { status: OkrStatus }) {
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', statusTone[status].pill)}>
      {OKR_STATUS_LABEL[status]}
    </span>
  );
}

// Progress bar with a tick where the progress "should" be by now.
export function OkrProgressBar({ progress, expected, status, label }: { progress: number; expected?: number; status: OkrStatus; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={`${formatPercent(progress)}${expected !== undefined ? `; esperado a la fecha ${formatPercent(expected)}` : ''}`}
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-sunken"
      >
        <div className={clsx('h-full rounded-full', statusTone[status].bar)} style={{ width: `${Math.min(100, progress)}%` }} />
        {expected !== undefined && expected > 0 && expected < 100 && (
          <span aria-hidden className="absolute inset-y-0 w-0.5 bg-ink/40" style={{ left: `${expected}%` }} title={`Esperado a la fecha: ${formatPercent(expected)}`} />
        )}
      </div>
      <span className="tabular w-12 text-right text-xs font-bold">{formatPercent(progress)}</span>
    </div>
  );
}
