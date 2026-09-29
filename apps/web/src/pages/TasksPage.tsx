import clsx from 'clsx';
import { Inbox, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { TaskCreateDialog } from '../components/task/TaskCreateDialog';
import { TaskList } from '../components/task/TaskList';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { Select } from '../components/ui/Field';
import { STATUS_LABEL } from '../lib/labels';
import { canCreateTasks } from '../lib/permissions';
import { useDepartments, useTasks, type TaskFilters } from '../lib/queries';
import type { TaskStatus } from '../lib/types';
import { useAuth } from '../stores/auth';

const WEEKS = [
  { value: 'last', label: 'Pasada' },
  { value: 'this', label: 'Esta semana' },
  { value: 'next', label: 'Próxima' },
  { value: 'all', label: 'Todas' },
] as const;

const STATUS_ORDER: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];

// Filters live in the URL: shareable, survive reloads, and the sidebar's
// department links are just links.
function useFilters() {
  const [params, setParams] = useSearchParams();
  const week = (params.get('week') ?? 'this') as (typeof WEEKS)[number]['value'];
  const status = (params.get('status')?.split(',').filter(Boolean) ?? []) as TaskStatus[];
  const filters: TaskFilters = {
    week: week === 'all' ? undefined : week,
    departmentId: params.get('department') ?? undefined,
    status: status.length ? status : undefined,
    assignedTo: params.get('mine') === '1' ? 'me' : undefined,
    search: params.get('q') ?? undefined,
    page: Number(params.get('page') ?? 1),
    sortBy: 'createdAt',
    sortOrder: 'desc',
  };
  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
        if (!('page' in patch)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  return { filters, week, status, raw: params, update };
}

export default function TasksPage() {
  const user = useAuth((s) => s.user)!;
  const { filters, week, status, raw, update } = useFilters();
  const departments = useDepartments();
  const tasks = useTasks(filters);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(raw.get('q') ?? '');

  // Debounce typing into the URL (and so into the query).
  useEffect(() => {
    const t = setTimeout(() => {
      if ((raw.get('q') ?? '') !== search) update({ q: search.trim() || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const departmentName = useMemo(
    () => departments.data?.find((d) => d.id === filters.departmentId)?.name,
    [departments.data, filters.departmentId],
  );
  const toggleStatus = (s: TaskStatus) => {
    const next = status.includes(s) ? status.filter((x) => x !== s) : [...status, s];
    update({ status: next.length ? next.join(',') : null });
  };
  const total = tasks.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const hasFilters = !!(filters.departmentId || status.length || filters.assignedTo || filters.search);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{departmentName ?? 'Tareas'}</h1>
          <p className="mt-1 text-sm text-muted">
            {tasks.isLoading ? 'Cargando…' : `${total} ${total === 1 ? 'tarea' : 'tareas'}`}
            {user.role === 'USER' && ' · Actualiza tu avance cada día'}
          </p>
        </div>
        {canCreateTasks(user) && (
          <Button onClick={() => setCreating(true)} icon={<Plus className="size-4" />}>
            Nueva tarea
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="space-y-3 rounded-2xl border border-line bg-surface p-3 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Semana" className="flex rounded-lg bg-sunken p-0.5">
            {WEEKS.map((w) => (
              <button
                key={w.value}
                role="radio"
                aria-checked={week === w.value}
                onClick={() => update({ week: w.value === 'this' ? null : w.value })}
                className={clsx('rounded-md px-3 py-1.5 text-sm font-semibold transition', week === w.value ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink')}
              >
                {w.label}
              </button>
            ))}
          </div>

          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              aria-label="Buscar tareas"
              placeholder="Buscar por título, descripción o KPI"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
          </div>

          {(departments.data?.length ?? 0) > 1 && (
            <Select aria-label="Departamento" className="h-9 w-auto" value={filters.departmentId ?? ''} onChange={(e) => update({ department: e.target.value || null })}>
              <option value="">Todos los departamentos</option>
              {departments.data!.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              aria-pressed={status.includes(s)}
              onClick={() => toggleStatus(s)}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs font-semibold transition',
                status.includes(s) ? 'border-navy bg-navy text-white' : 'border-line-strong text-ink-soft hover:border-ink-soft',
              )}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-soft">
            <input type="checkbox" className="size-4 rounded accent-[var(--cp-primary)]" checked={filters.assignedTo === 'me'} onChange={(e) => update({ mine: e.target.checked ? '1' : null })} />
            Solo mis tareas
          </label>
          {hasFilters && (
            <button onClick={() => { setSearch(''); update({ department: null, status: null, mine: null, q: null }); }} className="ml-auto text-xs font-semibold text-brand hover:underline">
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {tasks.isError ? (
        <ErrorNotice message="No pudimos cargar las tareas." onRetry={() => void tasks.refetch()} />
      ) : tasks.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<Inbox className="size-5" />}
          title={hasFilters ? 'Nada coincide con estos filtros' : 'No hay tareas para esta semana'}
          action={
            canCreateTasks(user) && !hasFilters ? (
              <Button onClick={() => setCreating(true)} icon={<Plus className="size-4" />}>
                Crear la primera
              </Button>
            ) : undefined
          }
        >
          {hasFilters
            ? 'Prueba quitando algún filtro o cambiando de semana.'
            : canCreateTasks(user)
              ? 'Crea tareas y asígnalas a tu equipo.'
              : 'Cuando tu jefe te asigne tareas aparecerán aquí.'}
        </EmptyState>
      ) : (
        <div className={clsx('transition-opacity', tasks.isPlaceholderData && 'opacity-60')}>
          <TaskList tasks={tasks.data!.data} />
          {pages > 1 && (
            <nav aria-label="Paginación" className="mt-4 flex items-center justify-center gap-3 text-sm">
              <Button variant="secondary" size="sm" disabled={(filters.page ?? 1) <= 1} onClick={() => update({ page: String((filters.page ?? 1) - 1) })}>
                Anterior
              </Button>
              <span className="tabular text-muted">
                {filters.page} / {pages}
              </span>
              <Button variant="secondary" size="sm" disabled={(filters.page ?? 1) >= pages} onClick={() => update({ page: String((filters.page ?? 1) + 1) })}>
                Siguiente
              </Button>
            </nav>
          )}
        </div>
      )}

      <TaskCreateDialog open={creating} onClose={() => setCreating(false)} defaultDepartmentId={filters.departmentId} />
    </div>
  );
}
