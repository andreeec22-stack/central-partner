import clsx from 'clsx';
import { Ban } from 'lucide-react';
import { useState } from 'react';
import { PRIORITY_LABEL, PROGRESS_STEPS, SEMAPHORE_LABEL, STATUS_LABEL } from '../../lib/labels';
import type { Priority, Semaphore, TaskStatus } from '../../lib/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Textarea } from '../ui/Field';

// ─── Semaphore ──────────────────────────────────────────────────────────────
// Fixed colors (never branded). Shape is doubled with a label for color-blind users.

const semaphoreClass: Record<Semaphore, string> = {
  GREEN: 'bg-sem-green',
  YELLOW: 'bg-sem-yellow',
  RED: 'bg-sem-red',
  GRAY: 'bg-line-strong',
};

export function SemaphoreDot({ value, blocked, size = 'md' }: { value: Semaphore; blocked?: boolean; size?: 'sm' | 'md' }) {
  const label = blocked ? 'Bloqueada' : SEMAPHORE_LABEL[value];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-grid shrink-0 place-items-center rounded-full ring-2 ring-surface',
        size === 'md' ? 'size-3.5' : 'size-2.5',
        blocked ? 'bg-blocked' : semaphoreClass[value],
      )}
    />
  );
}

// ─── Progress picker ────────────────────────────────────────────────────────
// The daily "select %" from the Excel sheet: five segments, one tap.

export function ProgressPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const fill = value >= 90 ? 'bg-sem-green' : value >= 70 ? 'bg-sem-yellow' : 'bg-sem-red';
  return (
    <div className="flex items-center gap-2">
      <div role="group" aria-label="Progreso" className="flex gap-0.5">
        {PROGRESS_STEPS.map((step) => {
          const active = step <= value && !(step === 0 && value > 0);
          return (
            <button
              key={step}
              type="button"
              disabled={disabled}
              aria-pressed={value === step}
              aria-label={`${step}%`}
              title={`${step}%`}
              onClick={() => step !== value && onChange(step)}
              className={clsx(
                'h-5 w-4 rounded-[3px] border transition first:rounded-l-md last:rounded-r-md',
                step === 0 ? 'w-2.5' : '',
                active && value > 0 ? `${fill} border-transparent` : 'border-line-strong bg-surface',
                value === 0 && step === 0 && 'border-sem-red bg-sem-red-soft',
                disabled ? 'cursor-default' : 'cursor-pointer hover:border-ink-soft',
              )}
            />
          );
        })}
      </div>
      <span className="w-9 text-right font-mono text-xs tabular text-ink-soft">{value}%</span>
    </div>
  );
}

// ─── Status ─────────────────────────────────────────────────────────────────

const statusStyle: Record<TaskStatus, string> = {
  TODO: 'bg-sunken text-ink-soft',
  IN_PROGRESS: 'bg-brand/10 text-brand',
  BLOCKED: 'bg-blocked-soft text-blocked',
  DONE: 'bg-sem-green-soft text-sem-green',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', statusStyle[status])}>
      {status === 'BLOCKED' && <Ban className="size-3" aria-hidden />}
      {STATUS_LABEL[status]}
    </span>
  );
}

// Choosing BLOCKED always asks for the reason first (it's mandatory in the API).
export function StatusControl({
  status,
  disabled,
  onChange,
}: {
  status: TaskStatus;
  disabled?: boolean;
  onChange: (status: TaskStatus, blockReason?: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  if (disabled) return <StatusBadge status={status} />;

  return (
    <>
      <select
        aria-label="Estado"
        value={status}
        onChange={(e) => {
          const next = e.target.value as TaskStatus;
          if (next === 'BLOCKED') {
            setReason('');
            setAsking(true);
          } else onChange(next);
        }}
        className={clsx(
          'h-7 cursor-pointer rounded-full border-0 py-0 pl-2.5 pr-7 text-xs font-semibold focus:ring-2 focus:ring-brand/30',
          statusStyle[status],
        )}
      >
        {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <BlockReasonDialog
        open={asking}
        reason={reason}
        setReason={setReason}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          onChange('BLOCKED', reason.trim());
        }}
      />
    </>
  );
}

export function BlockReasonDialog({
  open,
  reason,
  setReason,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  reason: string;
  setReason: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const valid = reason.trim().length > 0;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="¿Qué está bloqueando la tarea?"
      description="Tu jefe y el director verán este motivo."
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="danger" disabled={!valid} onClick={onConfirm} icon={<Ban className="size-4" />}>
            Marcar como bloqueada
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm();
        }}
      >
        <Field label="Motivo del bloqueo" hint={`${reason.length}/255`}>
          {(id, describedBy) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              autoFocus
              maxLength={255}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej.: Esperando aprobación de finanzas"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

// ─── Priority ───────────────────────────────────────────────────────────────

const priorityStyle: Record<Priority, string> = {
  LOW: 'text-muted',
  MEDIUM: 'text-ink-soft',
  HIGH: 'text-sem-yellow',
  URGENT: 'text-sem-red',
};

export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-xs font-semibold', priorityStyle[priority])}>
      <span aria-hidden className="flex items-end gap-px">
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={clsx('w-[3px] rounded-sm', bar <= ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].indexOf(priority) + 1 ? 'bg-current' : 'bg-line-strong')}
            style={{ height: 3 + bar * 2.5 }}
          />
        ))}
      </span>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
