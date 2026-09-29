import { History } from 'lucide-react';
import { useState } from 'react';
import { formatDate, formatDateTime, relativeTime } from '../../../lib/format';
import { FIELD_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '../../../lib/labels';
import type { ActivityEntry, Priority, TaskStatus } from '../../../lib/types';
import { useAuth } from '../../../stores/auth';

const ACTION_TEXT: Record<string, string> = {
  TASK_CREATED: 'creó la tarea',
  TASK_UPDATED: 'actualizó',
  TASK_BLOCKED: 'bloqueó la tarea',
  TASK_UNBLOCKED: 'desbloqueó la tarea',
  TASK_COMPLETED: 'completó la tarea',
  TASK_DEPENDENCY_ADDED: 'añadió una dependencia',
  TASK_DEPENDENCY_REMOVED: 'quitó una dependencia',
  COMMENT_ADDED: 'comentó',
  COMMENT_EDITED: 'editó un comentario',
  COMMENT_DELETED: 'borró un comentario',
  FILE_UPLOADED: 'adjuntó',
  FILE_DELETED: 'eliminó el archivo',
};

function formatValue(field: string, value: unknown, timeZone: string, people: Map<string, string>): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'status') return STATUS_LABEL[value as TaskStatus] ?? String(value);
  if (field === 'priority') return PRIORITY_LABEL[value as Priority] ?? String(value);
  if (field === 'progress') return `${value}%`;
  if (field === 'dueDate') return formatDate(String(value), timeZone);
  if (field === 'assignedToId') return people.get(String(value)) ?? 'otra persona';
  return String(value);
}

// Only fields a person cares about; derived bookkeeping (semaphore, metrics) is hidden.
const SHOWN = new Set(Object.keys(FIELD_LABEL).filter((f) => f !== 'departmentId' && f !== 'parentTaskId'));

function describe(entry: ActivityEntry, timeZone: string, people: Map<string, string>): string {
  const base = ACTION_TEXT[entry.action] ?? 'modificó la tarea';
  const meta = entry.metadata ?? {};
  if (entry.action === 'FILE_UPLOADED' || entry.action === 'FILE_DELETED') return `${base} "${meta.filename ?? 'un archivo'}"`;
  if (entry.action === 'TASK_CREATED') return base;
  const changes = Object.entries(entry.changes ?? {}).filter(([f]) => SHOWN.has(f));
  if (entry.action === 'TASK_UPDATED' && changes.length) {
    return changes
      .map(([f, c]) => `cambió ${FIELD_LABEL[f]}: ${formatValue(f, c.old, timeZone, people)} → ${formatValue(f, c.new, timeZone, people)}`)
      .join(' · ');
  }
  return base;
}

export function ActivitySection({ activity, people }: { activity: ActivityEntry[]; people: Map<string, string> }) {
  const user = useAuth((s) => s.user)!;
  const [all, setAll] = useState(false);
  const shown = all ? activity : activity.slice(0, 8);

  return (
    <section aria-labelledby="activity-heading" className="space-y-2">
      <h3 id="activity-heading" className="flex items-center gap-2 text-sm font-bold">
        <History className="size-4 text-muted" aria-hidden /> Actividad
      </h3>
      <ol className="relative space-y-3 border-l border-line pl-4">
        {shown.map((a) => (
          <li key={a.id} className="relative text-sm">
            <span aria-hidden className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-line-strong ring-2 ring-surface" />
            <p className="text-ink-soft">
              <span className="font-semibold text-ink">{a.user?.name ?? 'Sistema'}</span> {describe(a, user.timezone, people)}
            </p>
            <time dateTime={a.timestamp} title={formatDateTime(a.timestamp, user.timezone)} className="text-xs text-muted">
              {relativeTime(a.timestamp)}
            </time>
          </li>
        ))}
      </ol>
      {activity.length > 8 && (
        <button onClick={() => setAll((v) => !v)} className="text-xs font-semibold text-brand hover:underline">
          {all ? 'Ver menos' : `Ver toda la actividad (${activity.length})`}
        </button>
      )}
    </section>
  );
}
