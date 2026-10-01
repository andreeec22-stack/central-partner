import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { formatDate, formatDateTime, formatPercent } from '../../lib/format';
import { useCheckIn, useDeleteOkr, useOkr, type Okr } from '../../lib/okrs';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { ConfirmDialog } from '../admin/AdminKit';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Feedback';
import { Field, Input, Textarea } from '../ui/Field';
import { OKR_LEVEL_LABEL, OkrProgressBar, OkrStatusBadge } from './OkrBits';

const num = (n: number) => new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(n);

// Weekly check-in: new values for the key results plus notes.
export function CheckInForm({ okr, onDone }: { okr: Okr; onDone?: () => void }) {
  const checkIn = useCheckIn(okr.id);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(okr.keyResults.map((k) => [k.id, String(k.current)])));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const changed = okr.keyResults
      .map((k) => ({ id: k.id, current: Number(values[k.id]) }))
      .filter((v, i) => Number.isFinite(v.current) && v.current !== okr.keyResults[i]!.current);
    if (!changed.length && !notes.trim()) {
      setError('Actualiza al menos un resultado clave o escribe una nota');
      return;
    }
    setError(null);
    try {
      await checkIn.mutateAsync({ keyResults: changed, notes: notes.trim() || null });
      toast.success('Avance registrado');
      setNotes('');
      onDone?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo registrar el avance');
    }
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-paper/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-bold">Registrar avance de la semana</h3>
      {okr.keyResults.map((k) => (
        <label key={k.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">{k.title}</span>
          {/* Fixed-width wrapper: the control's own w-full wins over a width class. */}
          <span className="w-28 shrink-0">
            <Input
              type="number"
              step="any"
              aria-label={`Valor actual de ${k.title}`}
              value={values[k.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [k.id]: e.target.value }))}
            />
          </span>
          <span className="w-28 shrink-0 text-xs text-muted">
            meta {num(k.target)} {k.unit ?? ''}
          </span>
        </label>
      ))}
      <Field label="Notas (bloqueos, cambios)">{(id) => <Textarea id={id} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      {error && (
        <p role="alert" className="text-sm font-medium text-sem-red">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={checkIn.isPending}>
          Guardar avance
        </Button>
      </div>
    </form>
  );
}

export function OkrDetailDialog({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (okr: Okr) => void }) {
  const tz = useAuth((s) => s.user?.timezone) ?? 'America/Lima';
  const q = useOkr(id);
  const remove = useDeleteOkr();
  const [confirm, setConfirm] = useState(false);
  const okr = q.data?.okr;

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={okr?.title ?? 'Objetivo'}
      description={
        okr
          ? `${OKR_LEVEL_LABEL[okr.level]}${okr.department ? ` · ${okr.department.name}` : ''}${okr.owner ? ` · ${okr.owner.displayName}` : ''} · vence ${okr.deadline ? formatDate(`${okr.deadline}T12:00:00Z`, tz) : 'al cierre del trimestre'}`
          : undefined
      }
      footer={
        okr?.permissions.canEdit ? (
          <>
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Eliminar
            </Button>
            <Button variant="secondary" onClick={() => onEdit(okr)}>
              Editar
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isPending ? (
        <Spinner className="py-10" />
      ) : q.isError || !okr ? (
        <p className="text-sm text-sem-red">No se pudo cargar el objetivo.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <OkrStatusBadge status={okr.status} />
            <span className="text-xs text-muted">Esperado a la fecha: {formatPercent(okr.expectedProgress)}</span>
          </div>
          <OkrProgressBar progress={okr.progress} expected={okr.expectedProgress} status={okr.status} label="Avance del objetivo" />
          {okr.description && <p className="whitespace-pre-line text-sm text-ink-soft">{okr.description}</p>}

          <section aria-label="Resultados clave">
            <h3 className="text-sm font-bold">Resultados clave</h3>
            <ul className="mt-2 space-y-3">
              {okr.keyResults.map((k) => (
                <li key={k.id}>
                  <p className="text-sm">
                    {k.title}{' '}
                    <span className="text-xs text-muted">
                      ({num(k.current)} de {num(k.startValue)} → {num(k.target)} {k.unit ?? ''})
                    </span>
                  </p>
                  <OkrProgressBar progress={k.progress} status={okr.status === 'COMPLETED' ? 'COMPLETED' : k.progress >= 100 ? 'COMPLETED' : okr.status} label={k.title} />
                </li>
              ))}
            </ul>
          </section>

          {okr.permissions.canCheckIn && <CheckInForm okr={okr} />}

          <section aria-label="Historial de avances">
            <h3 className="text-sm font-bold">Historial</h3>
            {q.data.checkIns.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Aún no hay avances registrados.</p>
            ) : (
              <ol className="mt-2 space-y-2">
                {q.data.checkIns.map((c) => (
                  <li key={c.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                    <p>
                      <span className="font-semibold">{c.author.displayName}</span> <span className="text-muted">· {formatDateTime(c.createdAt, tz)}</span>{' '}
                      <span className="tabular font-bold">→ {formatPercent(c.progress)}</span>
                    </p>
                    {c.notes && <p className="mt-0.5 whitespace-pre-line text-ink-soft">{c.notes}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="¿Eliminar este objetivo?"
        description={okr?.title}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate(id, { onSuccess: () => (setConfirm(false), onClose()) })}
      />
    </Dialog>
  );
}
