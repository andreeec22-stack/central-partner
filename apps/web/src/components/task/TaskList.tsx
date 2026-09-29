import clsx from 'clsx';
import { Calendar, MessageSquare, Paperclip, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDate, isOverdue } from '../../lib/format';
import { canDeleteTask, canEditTask } from '../../lib/permissions';
import { useDeleteTask, useUpdateTask, type TaskPatch } from '../../lib/queries';
import type { Task, User } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Field';
import { PriorityLabel, ProgressPicker, SemaphoreDot, StatusControl } from './TaskBits';

function useTaskActions() {
  const update = useUpdateTask();
  return (task: Task, patch: TaskPatch) => update.mutate({ id: task.id, patch });
}

// Saturday's "resultado real" for the KPI.
function KpiCell({ task, editable, onSave }: { task: Task; editable: boolean; onSave: (actual: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  if (!task.kpiTarget && !task.kpiActual) return <span className="text-muted">—</span>;

  const body = (
    <span className="flex flex-col text-left leading-tight">
      <span className="text-xs text-muted">Meta: {task.kpiTarget ?? '—'}</span>
      <span className={clsx('text-sm font-semibold', task.kpiActual ? 'text-ink' : 'text-muted italic')}>{task.kpiActual ?? 'Sin registrar'}</span>
    </span>
  );
  if (!editable) return body;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setValue(task.kpiActual ?? '');
          setOpen(true);
        }}
        className="rounded-md px-1 py-0.5 hover:bg-sunken"
        aria-label={`Registrar resultado del KPI de ${task.title}`}
      >
        {body}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Resultado del KPI"
        description={`Meta: ${task.kpiTarget ?? '—'}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" form={`kpi-${task.id}`}>
              Guardar
            </Button>
          </>
        }
      >
        <form
          id={`kpi-${task.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            onSave(value.trim() || null);
            setOpen(false);
          }}
        >
          <Field label="Resultado real">
            {(id) => <Input id={id} autoFocus maxLength={255} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ej.: 47 leads" />}
          </Field>
        </form>
      </Dialog>
    </>
  );
}

function DeleteButton({ task }: { task: Task }) {
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteTask();
  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} className="rounded-md p-1.5 text-muted hover:bg-sem-red-soft hover:text-sem-red" aria-label={`Eliminar ${task.title}`}>
        <Trash2 className="size-4" />
      </button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="¿Eliminar esta tarea?"
        description="Se archiva junto con sus archivos; queda en la auditoría."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(task.id, {
                  onSuccess: () => {
                    toast.success('Tarea eliminada');
                    setConfirming(false);
                  },
                  onError: () => toast.error('No se pudo eliminar'),
                })
              }
            >
              Eliminar
            </Button>
          </>
        }
      >
        <p className="text-sm">{task.title}</p>
      </Dialog>
    </>
  );
}

function TitleCell({ task, user, showAssignee, onOpen }: { task: Task; user: User; showAssignee?: boolean; onOpen: (id: string) => void }) {
  const overdue = task.status !== 'DONE' && isOverdue(task.dueDate, user.timezone);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className={clsx(
          'text-left font-semibold leading-snug hover:text-brand hover:underline',
          task.status === 'DONE' && 'text-ink-soft line-through decoration-line-strong',
        )}
      >
        {task.title}
      </button>
      {task.status === 'BLOCKED' && task.blockReason && (
        <p className="mt-0.5 text-xs font-medium text-blocked">Bloqueada: {task.blockReason}</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
        <PriorityLabel priority={task.priority} />
        {showAssignee && <span className="xl:hidden">{task.assignedTo?.displayName ?? 'Sin asignar'}</span>}
        <span>{task.department.name}</span>
        {task.dueDate && (
          <span className={clsx('inline-flex items-center gap-1', overdue && 'font-semibold text-sem-red')}>
            <Calendar className="size-3" aria-hidden />
            {formatDate(task.dueDate, user.timezone)}
            {overdue && ' · vencida'}
          </span>
        )}
        {task.sourceType === 'EXCEL_IMPORT' && <span className="rounded bg-sunken px-1.5 font-semibold">Importada</span>}
        {task.counts.comments > 0 && (
          <span className="inline-flex items-center gap-1" title={`${task.counts.comments} comentarios`}>
            <MessageSquare className="size-3" aria-hidden />
            {task.counts.comments}
          </span>
        )}
        {task.counts.files > 0 && (
          <span className="inline-flex items-center gap-1" title={`${task.counts.files} archivos`}>
            <Paperclip className="size-3" aria-hidden />
            {task.counts.files}
          </span>
        )}
      </p>
    </div>
  );
}

export function TaskList({ tasks, onOpen, openId }: { tasks: Task[]; onOpen: (id: string) => void; openId?: string | null }) {
  const user = useAuth((s) => s.user)!;
  const act = useTaskActions();

  return (
    <>
      {/* Desktop / tablet: dense table, the Excel sheet's successor. */}
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-surface shadow-card md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper/70 text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="w-8 py-2.5 pl-4">
                <span className="sr-only">Semáforo</span>
              </th>
              <th scope="col" className="py-2.5 pr-3">Tarea</th>
              <th scope="col" className="hidden py-2.5 pr-3 xl:table-cell">Responsable</th>
              <th scope="col" className="py-2.5 pr-3">Progreso</th>
              <th scope="col" className="py-2.5 pr-3">Estado</th>
              <th scope="col" className="hidden py-2.5 pr-3 xl:table-cell">KPI</th>
              <th scope="col" className="w-10 py-2.5 pr-3">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {tasks.map((task) => {
              const editable = canEditTask(user, task);
              return (
                <tr
                  key={task.id}
                  aria-current={openId === task.id || undefined}
                  className={clsx('align-top transition-colors hover:bg-paper/60', task.status === 'BLOCKED' && 'bg-blocked-soft/40', openId === task.id && 'bg-brand/5')}
                >
                  <td className="py-3.5 pl-4 pt-4">
                    <SemaphoreDot value={task.semaphore} blocked={task.status === 'BLOCKED'} />
                  </td>
                  <td className="w-full min-w-56 py-3 pr-3">
                    <TitleCell task={task} user={user} showAssignee onOpen={onOpen} />
                  </td>
                  <td className="hidden py-3 pr-3 whitespace-nowrap text-ink-soft xl:table-cell">
                    {task.assignedTo?.displayName ?? <span className="text-muted">Sin asignar</span>}
                  </td>
                  <td className="py-3 pr-3">
                    <ProgressPicker value={task.progress} disabled={!editable} onChange={(progress) => act(task, { progress })} />
                  </td>
                  <td className="py-3 pr-3">
                    <StatusControl
                      status={task.status}
                      disabled={!editable}
                      onChange={(status, blockReason) => act(task, blockReason ? { status, blockReason } : { status })}
                    />
                  </td>
                  <td className="hidden min-w-32 py-2.5 pr-3 xl:table-cell">
                    <KpiCell task={task} editable={editable} onSave={(kpiActual) => act(task, { kpiActual })} />
                  </td>
                  <td className="py-2.5 pr-3">{canDeleteTask(user, task) && <DeleteButton task={task} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per task, controls stacked for thumbs. */}
      <ul className="space-y-3 md:hidden">
        {tasks.map((task) => {
          const editable = canEditTask(user, task);
          return (
            <li key={task.id} className={clsx('rounded-2xl border bg-surface p-4 shadow-card', task.status === 'BLOCKED' ? 'border-blocked/30' : 'border-line')}>
              <div className="flex gap-3">
                <div className="pt-1">
                  <SemaphoreDot value={task.semaphore} blocked={task.status === 'BLOCKED'} />
                </div>
                <div className="min-w-0 flex-1">
                  <TitleCell task={task} user={user} onOpen={onOpen} />
                  <p className="mt-1.5 text-xs text-ink-soft">{task.assignedTo?.displayName ?? 'Sin asignar'}</p>
                </div>
                {canDeleteTask(user, task) && <DeleteButton task={task} />}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <ProgressPicker value={task.progress} disabled={!editable} onChange={(progress) => act(task, { progress })} />
                <StatusControl status={task.status} disabled={!editable} onChange={(status, blockReason) => act(task, blockReason ? { status, blockReason } : { status })} />
              </div>
              {(task.kpiTarget || task.kpiActual) && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-paper px-3 py-2">
                  <Target className="size-4 text-muted" aria-hidden />
                  <KpiCell task={task} editable={editable} onSave={(kpiActual) => act(task, { kpiActual })} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
