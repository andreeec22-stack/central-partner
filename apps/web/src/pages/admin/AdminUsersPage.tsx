import clsx from 'clsx';
import { MailX, Pencil, RotateCcw, Search, UserPlus, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AdminPageHeader, AdminTable, ConfirmDialog, Pagination, RoleBadge, StatusBadge, td, th } from '../../components/admin/AdminKit';
import { CreateUserModal, EditUserModal } from '../../components/admin/UserModals';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import {
  useAdminUsers,
  useDeactivateUser,
  useInvitations,
  useRestoreUser,
  useRevokeInvitation,
  USERS_PAGE_SIZE,
  type AdminUser,
} from '../../lib/admin';
import { formatDate, formatDateTime, initials } from '../../lib/format';
import { ROLE_LABEL } from '../../lib/labels';
import { useDepartments } from '../../lib/queries';
import type { Role } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/toast';

function Invitations() {
  const me = useAuth((s) => s.user)!;
  const invitations = useInvitations();
  const revoke = useRevokeInvitation();
  const departments = useDepartments();
  if (!invitations.data?.length) return null;
  return (
    <section aria-labelledby="invitations-heading" className="space-y-2">
      <h2 id="invitations-heading" className="text-sm font-bold">
        Invitaciones pendientes <span className="font-normal text-muted">{invitations.data.length}</span>
      </h2>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
        {invitations.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate font-semibold">{i.email}</span>
            <RoleBadge role={i.role} />
            <span className="text-muted">{departments.data?.find((d) => d.id === i.departmentId)?.name ?? '—'}</span>
            <span className="text-xs text-muted">Vence {formatDateTime(i.expiresAt, me.timezone)}</span>
            <Button
              variant="ghost"
              size="sm"
              icon={<MailX className="size-4" />}
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(i.id, { onSuccess: () => toast.success('Invitación anulada') })}
            >
              Anular
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AdminUsersPage() {
  const me = useAuth((s) => s.user)!;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<'active' | 'deleted'>('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [deactivating, setDeactivating] = useState<AdminUser | null>(null);
  const deactivate = useDeactivateUser();
  const restore = useRestoreUser();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [debounced, role, status]);

  const users = useAdminUsers({ search: debounced || undefined, role: role || undefined, status, page });

  return (
    <div className="space-y-6">
      <AdminPageHeader
        section="Settings"
        title="Gestión de usuarios"
        description="Invita personas, cambia su rol o área y desactiva cuentas. Nada se borra: todo queda en la auditoría."
        actions={
          <Button icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
            Nuevo usuario
          </Button>
        }
      />

      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            aria-label="Buscar por nombre o correo"
            placeholder="Buscar por nombre o correo…"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <Select aria-label="Filtrar por rol" className="h-9 sm:w-44" value={role} onChange={(e) => setRole(e.target.value as Role | '')}>
          <option value="">Todos los roles</option>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <div role="radiogroup" aria-label="Estado" className="flex rounded-lg bg-sunken p-0.5">
          {(['active', 'deleted'] as const).map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
              className={clsx('rounded-md px-3 py-1.5 text-sm font-semibold', status === s ? 'bg-surface shadow-card' : 'text-ink-soft')}
            >
              {s === 'active' ? 'Activos' : 'Desactivados'}
            </button>
          ))}
        </div>
      </div>

      {users.isError ? (
        <ErrorNotice message="No pudimos cargar los usuarios." onRetry={() => void users.refetch()} />
      ) : users.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : users.data!.data.length === 0 ? (
        <EmptyState icon={<Search className="size-5" />} title="Nadie coincide">
          Prueba con otro nombre, correo o rol.
        </EmptyState>
      ) : (
        <div className={clsx('space-y-3 transition-opacity', users.isPlaceholderData && 'opacity-60')}>
          <AdminTable
            caption="Usuarios del espacio de trabajo"
            head={
              <tr>
                <th scope="col" className={th}>
                  #
                </th>
                <th scope="col" className={th}>
                  Nombre
                </th>
                <th scope="col" className={th}>
                  Email
                </th>
                <th scope="col" className={th}>
                  Rol
                </th>
                <th scope="col" className={th}>
                  Departamento
                </th>
                <th scope="col" className={th}>
                  Estado
                </th>
                <th scope="col" className={th}>
                  Alta
                </th>
                <th scope="col" className={th}>
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            }
          >
            {users.data!.data.map((u, i) => (
              <tr key={u.id} className="hover:bg-paper/60">
                <td className={clsx(td, 'tabular text-muted')}>{(page - 1) * USERS_PAGE_SIZE + i + 1}</td>
                <td className={td}>
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-navy text-xs font-bold text-white">
                      {initials(u.displayName)}
                    </span>
                    <span className="font-semibold">
                      {u.displayName}
                      {u.id === me.id && <span className="ml-1.5 text-xs font-normal text-muted">(tú)</span>}
                    </span>
                  </span>
                </td>
                <td className={clsx(td, 'text-ink-soft')}>{u.email}</td>
                <td className={td}>
                  <RoleBadge role={u.role} />
                  {u.role === 'JEFE_AREA' && u.canCreateTasks && <span className="ml-1.5 text-xs text-muted">crea tareas</span>}
                </td>
                <td className={clsx(td, 'text-ink-soft')}>{u.department?.name ?? '—'}</td>
                <td className={td}>
                  <StatusBadge active={!u.deletedAt}>{u.deletedAt ? 'Desactivado' : 'Activo'}</StatusBadge>
                </td>
                <td className={clsx(td, 'whitespace-nowrap text-xs text-muted')} title={u.lastLoginAt ? `Último acceso: ${formatDateTime(u.lastLoginAt, me.timezone)}` : 'Nunca ingresó'}>
                  {u.createdAt ? formatDate(u.createdAt, me.timezone) : '—'}
                </td>
                <td className={clsx(td, 'text-right whitespace-nowrap')}>
                  {u.deletedAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<RotateCcw className="size-4" />}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(u.id, { onSuccess: () => toast.success(`${u.displayName} reactivado`) })}
                    >
                      Reactivar
                    </Button>
                  ) : (
                    <span className="inline-flex gap-1">
                      <button onClick={() => setEditing(u)} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" aria-label={`Editar ${u.displayName}`}>
                        <Pencil className="size-4" />
                      </button>
                      {u.id !== me.id && (
                        <button onClick={() => setDeactivating(u)} className="rounded-md p-1.5 text-muted hover:bg-sem-red-soft hover:text-sem-red" aria-label={`Desactivar ${u.displayName}`}>
                          <UserX className="size-4" />
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </AdminTable>
          <Pagination page={page} total={users.data!.total} pageSize={USERS_PAGE_SIZE} onPage={setPage} label="usuarios" />
        </div>
      )}

      {status === 'active' && <Invitations />}

      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
      <EditUserModal user={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deactivating}
        title={`¿Desactivar a ${deactivating?.displayName}?`}
        description="No podrá entrar y se cerrarán sus sesiones. Sus tareas y su historial se conservan; puedes reactivarlo cuando quieras."
        confirmLabel="Desactivar"
        loading={deactivate.isPending}
        onClose={() => setDeactivating(null)}
        onConfirm={() =>
          deactivate.mutate(deactivating!.id, {
            onSuccess: () => {
              toast.success(`${deactivating!.displayName} desactivado`);
              setDeactivating(null);
            },
          })
        }
      />
    </div>
  );
}
