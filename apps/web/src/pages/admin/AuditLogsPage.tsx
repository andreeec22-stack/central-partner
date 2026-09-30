import clsx from 'clsx';
import { FileSpreadsheet, FileText, History, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AdminPageHeader, AdminTable, Pagination, td, th } from '../../components/admin/AdminKit';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { AUDIT_PAGE_SIZE, downloadAudit, useAuditLogs, type AuditEntry, type AuditFilters } from '../../lib/admin';
import { formatDateTime } from '../../lib/format';
import { FIELD_LABEL } from '../../lib/labels';
import { useUsers } from '../../lib/queries';
import { useAuth } from '../../stores/auth';

// Grouped for the action filter (labels come from the API for each row).
const ACTION_GROUPS: { label: string; actions: [string, string][] }[] = [
  {
    label: 'Tareas',
    actions: [
      ['TASK_CREATED', 'Creó tarea'],
      ['TASK_UPDATED', 'Actualizó tarea'],
      ['TASK_COMPLETED', 'Completó tarea'],
      ['TASK_BLOCKED', 'Bloqueó tarea'],
      ['TASK_DELETED', 'Eliminó tarea'],
      ['TASK_OBSERVATION_SET', 'Escribió observación'],
      ['COMMENT_ADDED', 'Comentó'],
      ['FILE_UPLOADED', 'Subió archivo'],
    ],
  },
  {
    label: 'Semana, KPIs y funciones',
    actions: [
      ['WEEK_CREATED', 'Abrió semana'],
      ['WEEK_CLOSED', 'Cerró semana'],
      ['KPI_CREATED', 'Creó KPI'],
      ['KPI_RECORDED', 'Registró resultado de KPI'],
      ['FUNCTION_MARKED', 'Marcó función'],
    ],
  },
  {
    label: 'Usuarios y accesos',
    actions: [
      ['USER_INVITED', 'Invitó usuario'],
      ['INVITATION_ACCEPTED', 'Aceptó invitación'],
      ['USER_UPDATED', 'Actualizó usuario'],
      ['USER_DELETED', 'Desactivó usuario'],
      ['USER_RESTORED', 'Reactivó usuario'],
      ['PERMISSIONS_UPDATED', 'Cambió permisos'],
      ['USER_LOGGED_IN', 'Inició sesión'],
    ],
  },
  {
    label: 'Configuración',
    actions: [
      ['DEPARTMENT_CREATED', 'Creó departamento'],
      ['DEPARTMENT_UPDATED', 'Actualizó departamento'],
      ['DEPARTMENT_DELETED', 'Desactivó departamento'],
      ['WORKSPACE_SETTINGS_UPDATED', 'Cambió la configuración'],
      ['BRANDING_UPDATED', 'Cambió la marca'],
      ['EXCEL_IMPORT_CONFIRMED', 'Confirmó importación'],
    ],
  },
];

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Changes({ entry }: { entry: AuditEntry }) {
  const changes = Object.entries(entry.changes ?? {});
  if (!changes.length) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer font-semibold text-brand">Ver cambios ({changes.length})</summary>
      <dl className="mt-1 space-y-0.5 rounded-md bg-paper px-2 py-1.5">
        {changes.map(([field, c]) => (
          <div key={field} className="flex flex-wrap gap-x-1.5">
            <dt className="font-semibold">{FIELD_LABEL[field] ?? field}:</dt>
            <dd className="break-all text-ink-soft">
              <span className="line-through decoration-muted">{show(c.old)}</span> → <span className="text-ink">{show(c.new)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default function AuditLogsPage() {
  const me = useAuth((s) => s.user)!;
  const users = useUsers();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Omit<AuditFilters, 'page'>>({});
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, search: search.trim() || undefined })), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [filters]);

  const logs = useAuditLogs({ ...filters, page });
  const set = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const exportAs = async (format: 'csv' | 'xlsx') => {
    setExporting(format);
    await downloadAudit(format, filters);
    setExporting(null);
  };
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Auditoría"
        description="Quién hizo qué y cuándo, con los valores de antes y después. El registro no se puede editar."
        actions={
          <>
            <Button variant="secondary" icon={<FileText className="size-4" />} loading={exporting === 'csv'} disabled={!logs.data?.total} onClick={() => void exportAs('csv')}>
              CSV
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet className="size-4" />} loading={exporting === 'xlsx'} disabled={!logs.data?.total} onClick={() => void exportAs('xlsx')}>
              Excel
            </Button>
          </>
        }
      />

      <div role="group" aria-label="Filtros de auditoría" className="grid gap-2 rounded-2xl border border-line bg-surface p-3 shadow-card sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            aria-label="Buscar por usuario o acción"
            placeholder="Buscar usuario o acción…"
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
        </div>
        <Select aria-label="Usuario" className="h-9" value={filters.userId ?? ''} onChange={(e) => set({ userId: e.target.value || undefined })}>
          <option value="">Todos los usuarios</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </Select>
        <Select aria-label="Acción" className="h-9" value={filters.action ?? ''} onChange={(e) => set({ action: e.target.value || undefined })}>
          <option value="">Todas las acciones</option>
          {ACTION_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.actions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Input type="date" aria-label="Desde" className="h-9" value={filters.from ?? ''} max={filters.to} onChange={(e) => set({ from: e.target.value || undefined })} />
        <Input type="date" aria-label="Hasta" className="h-9" value={filters.to ?? ''} min={filters.from} onChange={(e) => set({ to: e.target.value || undefined })} />
      </div>

      {logs.isError ? (
        <ErrorNotice message="No pudimos cargar la auditoría." onRetry={() => void logs.refetch()} />
      ) : logs.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : !logs.data?.data.length ? (
        <EmptyState icon={<History className="size-5" />} title={hasFilters ? 'Nada coincide con estos filtros' : 'Aún no hay actividad'} />
      ) : (
        <div className={clsx('space-y-3 transition-opacity', logs.isPlaceholderData && 'opacity-60')}>
          <AdminTable
            caption="Registro de auditoría"
            head={
              <tr>
                <th scope="col" className={th}>
                  Fecha
                </th>
                <th scope="col" className={th}>
                  Usuario
                </th>
                <th scope="col" className={th}>
                  Acción
                </th>
                <th scope="col" className={th}>
                  Detalle
                </th>
                <th scope="col" className={th}>
                  Entidad
                </th>
              </tr>
            }
          >
            {logs.data.data.map((l) => (
              <tr key={l.id} className="align-top hover:bg-paper/60">
                <td className={`${td} whitespace-nowrap tabular text-ink-soft`}>{formatDateTime(l.timestamp, me.timezone)}</td>
                <td className={td}>
                  {l.user ? (
                    <>
                      <span className="font-semibold">{l.user.name}</span>
                      <span className="block text-xs text-muted">{l.user.email}</span>
                    </>
                  ) : (
                    <span className="text-muted">Sistema</span>
                  )}
                </td>
                <td className={`${td} font-semibold`}>{l.actionLabel}</td>
                <td className={`${td} max-w-md`}>
                  <span className="break-words">{l.entityLabel ?? '—'}</span>
                  <Changes entry={l} />
                </td>
                <td className={`${td} text-xs text-muted`}>{l.entityType}</td>
              </tr>
            ))}
          </AdminTable>
          <Pagination page={page} total={logs.data.total} pageSize={AUDIT_PAGE_SIZE} onPage={setPage} label="auditoría" />
        </div>
      )}
    </div>
  );
}
