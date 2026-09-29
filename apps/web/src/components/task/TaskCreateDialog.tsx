import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { dateInputToIso } from '../../lib/format';
import { PRIORITY_LABEL } from '../../lib/labels';
import { useCreateTask, useDepartments, useUsers } from '../../lib/queries';
import type { Priority } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select, Textarea } from '../ui/Field';

const empty = { title: '', description: '', departmentId: '', assignedTo: '', priority: 'MEDIUM' as Priority, dueDate: '', kpiTarget: '' };

export function TaskCreateDialog({ open, onClose, defaultDepartmentId }: { open: boolean; onClose: () => void; defaultDepartmentId?: string }) {
  const user = useAuth((s) => s.user)!;
  const isAdmin = user.role === 'ADMIN';
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const departments = useDepartments();
  const create = useCreateTask();

  // A JEFE_AREA creates only in their own department; the director picks one.
  const departmentId = isAdmin ? form.departmentId : (user.departmentId ?? '');
  const people = useUsers(departmentId || undefined, open && !!departmentId);

  useEffect(() => {
    if (open) {
      setForm({ ...empty, departmentId: defaultDepartmentId ?? '' });
      setErrors({});
    }
  }, [open, defaultDepartmentId]);

  const set = <K extends keyof typeof empty>(k: K, v: (typeof empty)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return setErrors({ title: 'Escribe un título' });
    if (!departmentId) return setErrors({ departmentId: 'Elige un departamento' });
    try {
      await create.mutateAsync({
        title: form.title.trim(),
        description: form.description.trim() || null,
        departmentId,
        assignedTo: form.assignedTo || null,
        priority: form.priority,
        dueDate: dateInputToIso(form.dueDate),
        kpiTarget: form.kpiTarget.trim() || null,
      });
      toast.success('Tarea creada');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        const fe = err.fieldErrors;
        setErrors(Object.keys(fe).length ? { ...fe, ...(fe.assignedTo ? { assignedTo: err.message } : {}) } : { form: err.message });
      } else setErrors({ form: 'No se pudo crear la tarea' });
    }
  }

  // Viewers can't be assigned tasks.
  const assignable = (people.data ?? []).filter((p) => p.role !== 'VIEWER');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nueva tarea"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="create-task" loading={create.isPending} icon={<Plus className="size-4" />}>
            Crear tarea
          </Button>
        </>
      }
    >
      <form id="create-task" onSubmit={submit} className="space-y-4" noValidate>
        {errors.form && <p className="rounded-lg bg-sem-red-soft px-3 py-2 text-sm text-sem-red">{errors.form}</p>}
        <Field label="Título" error={errors.title}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} autoFocus maxLength={255} invalid={!!errors.title} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Ej.: Publicar 5 posts de la campaña" />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          {isAdmin ? (
            <Field label="Departamento" error={errors.departmentId}>
              {(id, d) => (
                <Select id={id} aria-describedby={d} invalid={!!errors.departmentId} value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value, assignedTo: '' }))}>
                  <option value="">Elige…</option>
                  {departments.data?.map((dep) => (
                    <option key={dep.id} value={dep.id}>
                      {dep.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label="Departamento">
              {(id) => <Input id={id} disabled value={departments.data?.find((d) => d.id === departmentId)?.name ?? '—'} />}
            </Field>
          )}
          <Field label="Responsable" error={errors.assignedTo} hint="Una sola persona por tarea">
            {(id, d) => (
              <Select id={id} aria-describedby={d} invalid={!!errors.assignedTo} disabled={!departmentId} value={form.assignedTo} onChange={(e) => set('assignedTo', e.target.value)}>
                <option value="">Sin asignar</option>
                {assignable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Prioridad">
            {(id) => (
              <Select id={id} value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
                {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Fecha límite" error={errors.dueDate}>
            {(id, d) => <Input id={id} aria-describedby={d} type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />}
          </Field>
        </div>

        <Field label="Meta del KPI" hint="Lo que se medirá el sábado, ej.: 50 leads">
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={255} value={form.kpiTarget} onChange={(e) => set('kpiTarget', e.target.value)} />}
        </Field>
        <Field label="Descripción" error={errors.description}>
          {(id, d) => <Textarea id={id} aria-describedby={d} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
