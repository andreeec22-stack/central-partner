import clsx from 'clsx';
import { Check, Lock, Minus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AdminPageHeader } from '../../components/admin/AdminKit';
import { Button } from '../../components/ui/Button';
import { ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { usePermissions, useUpdateJefe, type JefeSettings, type RolePermissions } from '../../lib/admin';
import { useDepartments } from '../../lib/queries';
import { toast } from '../../stores/toast';

function PermissionMark({ granted }: { granted: boolean | 'configurable' }) {
  if (granted === 'configurable') {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded bg-brand/10 text-brand" title="Configurable por persona">
        <SlidersHorizontal className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <span className={clsx('grid size-5 shrink-0 place-items-center rounded', granted ? 'bg-sem-green-soft text-sem-green' : 'bg-sunken text-muted')}>
      {granted ? <Check className="size-3.5" aria-hidden /> : <Minus className="size-3.5" aria-hidden />}
    </span>
  );
}

const GRANTED_TEXT = { true: 'permitido', false: 'no permitido', configurable: 'configurable por jefe' };

export function RolePermissionCard({ role }: { role: RolePermissions }) {
  return (
    <section aria-labelledby={`role-${role.role}`} className="rounded-2xl border border-line bg-surface p-4 shadow-card">
      <h2 id={`role-${role.role}`} className="font-bold">
        {role.label}
      </h2>
      <p className="text-xs text-muted">{role.description}</p>
      <ul className="mt-3 space-y-2">
        {role.permissions.map((p) => (
          <li key={p.key} className={clsx('flex items-center gap-2.5 text-sm', p.granted === false && 'text-muted')}>
            <PermissionMark granted={p.granted} />
            <span>{p.label}</span>
            <span className="sr-only">: {GRANTED_TEXT[String(p.granted) as keyof typeof GRANTED_TEXT]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// One area head: task creation + which other areas they can see (read-only).
export function JefePermissionRow({ jefe }: { jefe: JefeSettings }) {
  const departments = useDepartments();
  const update = useUpdateJefe();
  const [canCreate, setCanCreate] = useState(jefe.canCreateTasks);
  const [visible, setVisible] = useState(new Set(jefe.visibleDepartmentIds));

  useEffect(() => {
    setCanCreate(jefe.canCreateTasks);
    setVisible(new Set(jefe.visibleDepartmentIds));
  }, [jefe]);

  const others = (departments.data ?? []).filter((d) => d.id !== jefe.departmentId);
  const dirty = canCreate !== jefe.canCreateTasks || [...visible].sort().join() !== [...jefe.visibleDepartmentIds].sort().join();
  const toggle = (id: string) =>
    setVisible((v) => {
      const next = new Set(v);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () =>
    update.mutate(
      { userId: jefe.id, canCreateTasks: canCreate, visibleDepartmentIds: [...visible] },
      { onSuccess: () => toast.success(`Permisos de ${jefe.displayName} guardados`) },
    );

  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">{jefe.displayName}</p>
          <p className="text-xs text-muted">
            Jefe de {jefe.departmentName ?? 'sin área'} · {jefe.email}
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="size-4 accent-[var(--cp-primary)]" checked={canCreate} onChange={(e) => setCanCreate(e.target.checked)} />
          Puede crear tareas
        </label>
      </div>
      <fieldset>
        <legend className="text-xs font-semibold text-ink-soft">Ver también (solo lectura)</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {others.map((d) => (
            <label
              key={d.id}
              className={clsx(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40',
                visible.has(d.id) ? 'border-brand bg-brand/10 text-brand' : 'border-line-strong text-ink-soft hover:border-ink-soft',
              )}
            >
              <input type="checkbox" className="sr-only" checked={visible.has(d.id)} onChange={() => toggle(d.id)} />
              {d.name}
            </label>
          ))}
        </div>
      </fieldset>
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCanCreate(jefe.canCreateTasks);
              setVisible(new Set(jefe.visibleDepartmentIds));
            }}
          >
            Descartar
          </Button>
          <Button size="sm" loading={update.isPending} onClick={save}>
            Guardar cambios
          </Button>
        </div>
      )}
    </li>
  );
}

export default function PermissionsPage() {
  const permissions = usePermissions();
  return (
    <div className="space-y-6">
      <AdminPageHeader section="Settings" title="Permisos & roles" description="Qué puede hacer cada rol, y los ajustes de cada jefe de área." />

      {permissions.isError ? (
        <ErrorNotice message="No pudimos cargar los permisos." onRetry={() => void permissions.refetch()} />
      ) : !permissions.data ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <p className="flex items-start gap-2 rounded-xl bg-paper px-4 py-3 text-sm text-ink-soft">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Lo que puede hacer cada rol está fijo y el servidor lo verifica en cada acción: así nadie puede, por error, darle escritura a un lector o quitarle al
              director el cierre de semana. Lo configurable (<SlidersHorizontal className="inline size-3.5 align-[-2px]" aria-label="icono de configurable" />) se
              ajusta abajo, por jefe.
            </span>
          </p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {permissions.data.roles.map((r) => (
              <RolePermissionCard key={r.role} role={r} />
            ))}
          </div>

          <section aria-labelledby="jefes-heading" className="space-y-2">
            <h2 id="jefes-heading" className="text-lg font-bold">
              Jefes de área
            </h2>
            <p className="text-sm text-muted">Los cambios se aplican al instante: su pantalla se actualiza sola.</p>
            {permissions.data.jefes.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No hay jefes de área activos.</p>
            ) : (
              <ul className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
                {permissions.data.jefes.map((j) => (
                  <JefePermissionRow key={j.id} jefe={j} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
