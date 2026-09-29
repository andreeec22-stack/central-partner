import clsx from 'clsx';
import { Calendar, Pencil, Target, User as UserIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../../lib/api';
import { dateInputToIso, formatDate, formatDateTime, isOverdue } from '../../../lib/format';
import { PRIORITY_LABEL, SEMAPHORE_LABEL } from '../../../lib/labels';
import { isManagerOf } from '../../../lib/permissions';
import { useMentionable, useTaskDetail, useUpdateTask, useUsers, type TaskPatch } from '../../../lib/queries';
import type { Priority, Task, TaskDetail } from '../../../lib/types';
import { useAuth } from '../../../stores/auth';
import { Button } from '../../ui/Button';
import { ErrorNotice, Skeleton } from '../../ui/Feedback';
import { Input, Select, Textarea } from '../../ui/Field';
import { PriorityLabel, ProgressPicker, SemaphoreDot, StatusControl } from '../TaskBits';
import { ActivitySection } from './ActivitySection';
import { CommentsSection } from './CommentsSection';
import { FilesSection } from './FilesSection';

function Property({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-1.5 text-sm">
      <dt className="flex items-center gap-1.5 text-muted">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

// Click-to-edit text (title, description, KPI). Saves on blur or Enter.
function EditableText({
  value,
  onSave,
  multiline,
  placeholder,
  label,
  className,
  maxLength = 255,
}: {
  value: string | null;
  onSave: (v: string | null) => void;
  multiline?: boolean;
  placeholder: string;
  label: string;
  className?: string;
  maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const commit = () => {
    setEditing(false);
    const next = draft.trim() || null;
    if (next !== (value ?? null)) onSave(next);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value ?? '');
          setEditing(true);
        }}
        className={clsx('group w-full rounded-md px-1 py-0.5 text-left hover:bg-sunken', className)}
        aria-label={`Editar ${label}`}
      >
        {value ? <span className="whitespace-pre-wrap break-words">{value}</span> : <span className="italic text-muted">{placeholder}</span>}
        <Pencil className="ml-1.5 inline size-3 text-muted opacity-0 group-hover:opacity-100" aria-hidden />
      </button>
    );
  }
  const common = {
    autoFocus: true,
    value: draft,
    'aria-label': label,
    maxLength,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
  };
  return multiline ? (
    <Textarea {...common} rows={4} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(false))} />
  ) : (
    <Input
      {...common}
      className="h-9"
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

function Header({ task, canEdit, update }: { task: Task; canEdit: boolean; update: (p: TaskPatch) => void }) {
  const blocked = task.status === 'BLOCKED';
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="pt-2">
          <SemaphoreDot value={task.semaphore} blocked={blocked} />
        </div>
        <div className="min-w-0 flex-1 text-lg font-extrabold leading-snug tracking-tight">
          {canEdit ? <EditableText label="título" value={task.title} placeholder="Sin título" onSave={(t) => t && update({ title: t })} /> : <h2 className="px-1">{task.title}</h2>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 pl-6">
        <ProgressPicker value={task.progress} disabled={!canEdit} onChange={(progress) => update({ progress })} />
        <span className="text-xs font-semibold text-muted">{blocked ? 'Bloqueada' : SEMAPHORE_LABEL[task.semaphore]}</span>
      </div>
      {blocked && task.blockReason && (
        <p className="ml-6 rounded-lg bg-blocked-soft px-3 py-2 text-sm text-blocked">
          <span className="font-semibold">Bloqueada:</span> {task.blockReason}
        </p>
      )}
    </div>
  );
}

function Properties({ detail, update }: { detail: TaskDetail; update: (p: TaskPatch) => void }) {
  const user = useAuth((s) => s.user)!;
  const { task, permissions } = detail;
  const manager = isManagerOf(user, task);
  const users = useUsers(task.departmentId, manager && permissions.canEdit);
  const assignable = (users.data ?? []).filter((u) => u.role !== 'VIEWER');
  const overdue = task.status !== 'DONE' && isOverdue(task.dueDate, user.timezone);
  const dueValue = task.dueDate ? new Intl.DateTimeFormat('en-CA', { timeZone: user.timezone }).format(new Date(task.dueDate)) : '';

  return (
    <dl className="divide-y divide-line/60">
      <Property label="Estado">
        <StatusControl status={task.status} disabled={!permissions.canEdit} onChange={(status, blockReason) => update(blockReason ? { status, blockReason } : { status })} />
      </Property>
      <Property label="Prioridad">
        {permissions.canEdit ? (
          <Select aria-label="Prioridad" className="h-8 w-auto" value={task.priority} onChange={(e) => update({ priority: e.target.value as Priority })}>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        ) : (
          <PriorityLabel priority={task.priority} />
        )}
      </Property>
      <Property label="Responsable" icon={<UserIcon className="size-3.5" aria-hidden />}>
        {manager && permissions.canEdit ? (
          <Select aria-label="Responsable" className="h-8" value={task.assignedToId ?? ''} onChange={(e) => update({ assignedTo: e.target.value || null })}>
            <option value="">Sin asignar</option>
            {task.assignedTo && !assignable.some((u) => u.id === task.assignedToId) && <option value={task.assignedTo.id}>{task.assignedTo.displayName}</option>}
            {assignable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </Select>
        ) : (
          <span>{task.assignedTo?.displayName ?? <span className="text-muted">Sin asignar</span>}</span>
        )}
      </Property>
      <Property label="Departamento">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full" style={{ background: task.department.color ?? 'var(--color-line-strong)' }} />
          {task.department.name}
        </span>
      </Property>
      <Property label="Fecha límite" icon={<Calendar className="size-3.5" aria-hidden />}>
        {manager && permissions.canEdit ? (
          <Input
            type="date"
            aria-label="Fecha límite"
            className={clsx('h-8 w-auto', overdue && 'border-sem-red text-sem-red')}
            value={dueValue}
            onChange={(e) => update({ dueDate: dateInputToIso(e.target.value) })}
          />
        ) : (
          <span className={clsx(overdue && 'font-semibold text-sem-red')}>
            {formatDate(task.dueDate, user.timezone)}
            {overdue && ' · vencida'}
          </span>
        )}
      </Property>
      <Property label="Creada">
        <span className="text-ink-soft">
          {formatDateTime(task.createdAt, user.timezone)} · {task.createdBy.displayName}
        </span>
      </Property>
      <Property label="Meta KPI" icon={<Target className="size-3.5" aria-hidden />}>
        {manager && permissions.canEdit ? (
          <EditableText label="meta KPI" value={task.kpiTarget} placeholder="Sin meta" onSave={(kpiTarget) => update({ kpiTarget })} />
        ) : (
          <span>{task.kpiTarget ?? <span className="text-muted">—</span>}</span>
        )}
      </Property>
      <Property label="Resultado KPI">
        {permissions.canEdit ? (
          <EditableText label="resultado KPI" value={task.kpiActual} placeholder="Sin registrar" onSave={(kpiActual) => update({ kpiActual })} />
        ) : (
          <span>{task.kpiActual ?? <span className="text-muted">Sin registrar</span>}</span>
        )}
      </Property>
    </dl>
  );
}

function PanelBody({ detail }: { detail: TaskDetail }) {
  const { task, permissions } = detail;
  const updateTask = useUpdateTask();
  const update = (patch: TaskPatch) => updateTask.mutate({ id: task.id, patch });
  const people = useMentionable(task.id, true);
  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p.displayName])), [people.data]);

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <Header task={task} canEdit={permissions.canEdit} update={update} />
      <Properties detail={detail} update={update} />

      <section aria-label="Descripción" className="space-y-1.5">
        <h3 className="text-sm font-bold">Descripción</h3>
        {permissions.canEdit ? (
          <EditableText multiline label="descripción" maxLength={10_000} value={task.description} placeholder="Añade contexto para el equipo…" onSave={(description) => update({ description })} className="text-sm" />
        ) : (
          <p className="whitespace-pre-wrap text-sm text-ink-soft">{task.description ?? 'Sin descripción.'}</p>
        )}
      </section>

      <FilesSection taskId={task.id} files={detail.files} canAddFiles={permissions.canAddFiles} />
      <CommentsSection taskId={task.id} comments={detail.comments} canComment={permissions.canComment} />
      <ActivitySection activity={detail.activity} people={names} />
    </div>
  );
}

// Right-hand panel over the task list. Esc or the ✕ closes it; on phones it
// takes the whole screen. The list behind stays usable on desktop.
export function TaskDetailPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const detail = useTaskDetail(taskId);
  const panel = useRef<HTMLElement>(null);

  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Focus moves into the panel once per task, never on re-renders (that would
  // yank focus out of a half-written comment).
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('dialog'))) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [taskId]);

  const gone = detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <>
      <button aria-label="Cerrar detalle" onClick={onClose} className="fixed inset-0 z-30 bg-ink/30 md:hidden" />
      <aside
        ref={panel}
        tabIndex={-1}
        aria-label="Detalle de la tarea"
        className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-pop outline-none md:w-[450px]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <p className="text-sm font-bold text-ink-soft">Detalle de la tarea</p>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" aria-label="Cerrar detalle">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {detail.isLoading ? (
            <div className="space-y-4 p-6">
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : gone ? (
            <div className="p-6 text-center text-sm text-muted">
              <p className="font-semibold text-ink">Esta tarea ya no está disponible.</p>
              <p className="mt-1">Puede haber sido eliminada o movida a un departamento que no ves.</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          ) : detail.isError ? (
            <div className="p-6">
              <ErrorNotice message="No pudimos cargar la tarea." onRetry={() => void detail.refetch()} />
            </div>
          ) : (
            <PanelBody detail={detail.data!} />
          )}
        </div>
      </aside>
    </>
  );
}
