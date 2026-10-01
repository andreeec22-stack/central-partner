import { Building2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { AdminPageHeader, AdminTable, ConfirmDialog, td, th } from '../../components/admin/AdminKit';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { ApiError } from '../../lib/api';
import { useDeactivateDepartment, useSaveDepartment } from '../../lib/admin';
import { ROLE_LABEL } from '../../lib/labels';
import { useDepartments, useUsers } from '../../lib/queries';
import type { Department } from '../../lib/types';
import { toast } from '../../stores/toast';

const HEX = /^#[0-9a-f]{6}$/i;

function DepartmentModal({ open, department, onClose }: { open: boolean; department: Department | null; onClose: () => void }) {
  const save = useSaveDepartment();
  const users = useUsers(undefined, open);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563EB');
  const [description, setDescription] = useState('');
  const [headId, setHeadId] = useState('');
  const [target, setTarget] = useState('');
  const [touched, setTouched] = useState(false);
  const [nameTaken, setNameTaken] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(department?.name ?? '');
    setColor(department?.color ?? '#2563EB');
    setDescription(department?.description ?? '');
    setHeadId(department?.headId ?? '');
    setTarget(department?.performanceTarget ? String(department.performanceTarget) : '');
    setTouched(false);
    setNameTaken(false);
  }, [open, department]);

  const nameError = !name.trim() ? 'El nombre es obligatorio' : nameTaken ? 'Ya existe un departamento con ese nombre' : undefined;
  const colorError = HEX.test(color) ? undefined : 'Usa un color como #2563EB';
  // Heads: area heads first, then everyone else who can lead (not viewers).
  const candidates = (users.data ?? [])
    .filter((u) => u.role !== 'VIEWER')
    .sort((a, b) => Number(b.role === 'JEFE_AREA') - Number(a.role === 'JEFE_AREA') || a.displayName.localeCompare(b.displayName));

  const targetValue = target.trim() === '' ? null : Number(target);
  const targetError = targetValue === null || (Number.isInteger(targetValue) && targetValue >= 1 && targetValue <= 100) ? undefined : 'Un entero entre 1 y 100';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || colorError || targetError) return;
    save.mutate(
      { id: department?.id, input: { name: name.trim(), color: color.toUpperCase(), description: description.trim() || null, headId: headId || null, performanceTarget: targetValue } },
      {
        onSuccess: () => {
          toast.success(department ? 'Departamento actualizado' : `Departamento "${name.trim()}" creado`);
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setNameTaken(true);
          else toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar');
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={department ? 'Editar departamento' : 'Nuevo departamento'}
      description={department ? `Código: ${department.slug}` : 'El código se genera a partir del nombre.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="department-form" loading={save.isPending}>
            {department ? 'Guardar cambios' : 'Crear departamento'}
          </Button>
        </>
      }
    >
      <form id="department-form" noValidate onSubmit={submit} className="space-y-4">
        <Field label="Nombre" error={touched || nameTaken ? nameError : undefined}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              maxLength={80}
              value={name}
              invalid={(touched || nameTaken) && !!nameError}
              onChange={(e) => {
                setName(e.target.value);
                setNameTaken(false);
              }}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Jefe de área">
            {(id) => (
              <Select id={id} value={headId} onChange={(e) => setHeadId(e.target.value)}>
                <option value="">Sin asignar</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} · {ROLE_LABEL[u.role]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Color" error={touched ? colorError : undefined}>
            {(id, d) => (
              <div className="flex gap-2">
                <input type="color" aria-label="Color (selector)" value={HEX.test(color) ? color : '#000000'} onChange={(e) => setColor(e.target.value.toUpperCase())} className="h-10 w-12 cursor-pointer rounded-lg border border-line-strong p-1" />
                <Input id={id} aria-describedby={d} value={color} maxLength={7} className="font-mono uppercase" invalid={touched && !!colorError} onChange={(e) => setColor(e.target.value)} />
              </div>
            )}
          </Field>
        </div>
        <Field label="Meta de desempeño (%)" error={touched ? targetError : undefined} hint="Para el dashboard de desempeño. Vacío = 80%.">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={100} className="w-32" invalid={touched && !!targetError} value={target} onChange={(e) => setTarget(e.target.value)} />}
        </Field>
        <Field label="Descripción (opcional)">
          {(id) => <Textarea id={id} maxLength={500} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

export default function DepartmentsPage() {
  const departments = useDepartments();
  const deactivate = useDeactivateDepartment();
  const [editing, setEditing] = useState<Department | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Department | null>(null);

  const remove = () =>
    deactivate.mutate(removing!.id, {
      onSuccess: () => {
        toast.success(`"${removing!.name}" desactivado`);
        setRemoving(null);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'DEPARTMENT_NOT_EMPTY') {
          const n = (err.details as { activeTasks?: number } | undefined)?.activeTasks;
          toast.error(`"${removing!.name}" aún tiene ${n ?? 'algunas'} tareas activas: muévelas o elimínalas primero`);
        }
        setRemoving(null);
      },
    });

  return (
    <div className="space-y-6">
      <AdminPageHeader
        section="Settings"
        title="Departamentos"
        description="Las áreas de la empresa y quién las dirige."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Nuevo departamento
          </Button>
        }
      />

      {departments.isError ? (
        <ErrorNotice message="No pudimos cargar los departamentos." onRetry={() => void departments.refetch()} />
      ) : departments.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !departments.data?.length ? (
        <EmptyState icon={<Building2 className="size-5" />} title="Aún no hay departamentos" action={<Button onClick={() => setCreating(true)}>Crear el primero</Button>} />
      ) : (
        <AdminTable
          caption="Departamentos"
          minWidth="40rem"
          head={
            <tr>
              <th scope="col" className={th}>
                #
              </th>
              <th scope="col" className={th}>
                Nombre
              </th>
              <th scope="col" className={th}>
                Código
              </th>
              <th scope="col" className={th}>
                Jefe
              </th>
              <th scope="col" className={`${th} text-right`}>
                Personas
              </th>
              <th scope="col" className={th}>
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          }
        >
          {departments.data.map((d, i) => (
            <tr key={d.id} className="hover:bg-paper/60">
              <td className={`${td} tabular text-muted`}>{i + 1}</td>
              <td className={td}>
                <span className="flex items-center gap-2 font-semibold">
                  <span aria-hidden className="size-2.5 rounded-full" style={{ background: d.color ?? 'var(--color-line-strong)' }} />
                  {d.name}
                </span>
                {d.description && <span className="mt-0.5 block text-xs text-muted">{d.description}</span>}
              </td>
              <td className={`${td} font-mono text-xs text-ink-soft`}>{d.slug}</td>
              <td className={td}>{d.head?.displayName ?? <span className="text-muted">Sin asignar</span>}</td>
              <td className={`${td} text-right tabular`}>{d.usersCount}</td>
              <td className={`${td} text-right whitespace-nowrap`}>
                <button onClick={() => setEditing(d)} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" aria-label={`Editar ${d.name}`}>
                  <Pencil className="size-4" />
                </button>
                <button onClick={() => setRemoving(d)} className="rounded-md p-1.5 text-muted hover:bg-sem-red-soft hover:text-sem-red" aria-label={`Desactivar ${d.name}`}>
                  <Trash2 className="size-4" />
                </button>
              </td>
            </tr>
          ))}
        </AdminTable>
      )}

      <DepartmentModal open={creating || !!editing} department={editing} onClose={() => (setCreating(false), setEditing(null))} />
      <ConfirmDialog
        open={!!removing}
        title={`¿Desactivar "${removing?.name}"?`}
        description="Deja de aparecer en filtros y en el dashboard. Sus personas quedan sin área (conservan su cuenta). Solo se puede si no tiene tareas activas."
        confirmLabel="Desactivar"
        loading={deactivate.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
      />
    </div>
  );
}
