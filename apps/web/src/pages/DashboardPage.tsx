import clsx from 'clsx';
import { ArrowRight, Ban, CircleCheck, ListChecks, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorNotice, Skeleton } from '../components/ui/Feedback';
import { relativeTime } from '../lib/format';
import { ACTIVITY_LABEL, SEMAPHORE_LABEL } from '../lib/labels';
import { useDashboard } from '../lib/queries';
import type { Semaphore } from '../lib/types';
import { useAuth } from '../stores/auth';

const SEM_ORDER: Semaphore[] = ['GREEN', 'YELLOW', 'RED', 'GRAY'];
const semBar: Record<Semaphore, string> = { GREEN: 'bg-sem-green', YELLOW: 'bg-sem-yellow', RED: 'bg-sem-red', GRAY: 'bg-line-strong' };

function StatCard({ label, value, icon, tone, to }: { label: string; value: number; icon: ReactNode; tone: string; to: string }) {
  return (
    <Link to={to} className="group rounded-2xl border border-line bg-surface p-4 shadow-card transition hover:border-line-strong">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-soft">{label}</span>
        <span className={clsx('grid size-8 place-items-center rounded-lg', tone)}>{icon}</span>
      </div>
      <p className="mt-3 text-3xl font-extrabold tabular tracking-tight">{value}</p>
    </Link>
  );
}

// Stacked bar of the three semaphore colors; widths are shares of `total`.
function SemaphoreBar({ counts, className }: { counts: Record<Semaphore, number>; className?: string }) {
  const total = SEM_ORDER.reduce((n, k) => n + counts[k], 0);
  if (total === 0) return <div className={clsx('rounded-full bg-sunken', className)} />;
  return (
    <div className={clsx('flex overflow-hidden rounded-full bg-sunken', className)} role="img" aria-label={SEM_ORDER.map((k) => `${SEMAPHORE_LABEL[k]}: ${counts[k]}`).join(', ')}>
      {SEM_ORDER.map((k) => counts[k] > 0 && <span key={k} className={semBar[k]} style={{ width: `${(counts[k] / total) * 100}%` }} />)}
    </div>
  );
}

export default function DashboardPage() {
  const user = useAuth((s) => s.user)!;
  const dashboard = useDashboard();
  const d = dashboard.data;

  const greeting = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long', timeZone: user.timezone }).format(new Date());

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold text-muted first-letter:uppercase">{greeting}</p>
        <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">Hola, {user.displayName.split(' ')[0]}</h1>
      </div>

      {dashboard.isError && <ErrorNotice message="No pudimos cargar el panel." onRetry={() => void dashboard.refetch()} />}

      {dashboard.isLoading || !d ? (
        !dashboard.isError && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        )
      ) : d.summary.totalTasks === 0 ? (
        <EmptyState icon={<ListChecks className="size-5" />} title="Todavía no hay tareas">
          El panel se llena solo a medida que el equipo registra tareas y avance.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total" value={d.summary.totalTasks} to="/tasks?week=all" icon={<ListChecks className="size-4" />} tone="bg-sunken text-ink-soft" />
            <StatCard label="En progreso" value={d.summary.inProgressCount} to="/tasks?week=all&status=IN_PROGRESS" icon={<LoaderCircle className="size-4" />} tone="bg-brand/10 text-brand" />
            <StatCard label="Bloqueadas" value={d.summary.blockedCount} to="/tasks?week=all&status=BLOCKED" icon={<Ban className="size-4" />} tone="bg-blocked-soft text-blocked" />
            <StatCard label="Completadas" value={d.summary.completedCount} to="/tasks?week=all&status=DONE" icon={<CircleCheck className="size-4" />} tone="bg-sem-green-soft text-sem-green" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-card" aria-labelledby="sem-title">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="sem-title" className="font-bold">
                  Semáforo
                </h2>
                <ul className="flex gap-4 text-xs text-ink-soft">
                  {SEM_ORDER.map((k) => (
                    <li key={k} className="inline-flex items-center gap-1.5">
                      <span className={clsx('size-2.5 rounded-full', semBar[k])} aria-hidden />
                      {SEMAPHORE_LABEL[k]} <strong className="tabular text-ink">{d.semaphore[k]}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <SemaphoreBar counts={d.semaphore} className="mt-4 h-3" />

              <h3 className="mt-7 text-xs font-bold uppercase tracking-widest text-muted">Por departamento</h3>
              <ul className="mt-2 divide-y divide-line">
                {d.byDepartment.map((dep) => (
                  <li key={dep.id}>
                    <Link to={`/tasks?week=all&department=${dep.id}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[10rem_1fr_auto]">
                      <span className="flex items-center gap-2 truncate font-semibold">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: dep.color ?? 'var(--color-line-strong)' }} aria-hidden />
                        {dep.name}
                      </span>
                      <SemaphoreBar counts={dep.semaphore} className="order-last col-span-2 h-2 sm:order-none sm:col-span-1" />
                      <span className="text-right text-xs text-muted tabular">
                        {dep.totalTasks} · {dep.averageProgress ?? 0}%{dep.status.BLOCKED > 0 && <span className="ml-1.5 font-semibold text-blocked">{dep.status.BLOCKED} bloq.</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-2xl border border-line bg-surface p-5 shadow-card" aria-labelledby="act-title">
              <div className="flex items-center justify-between">
                <h2 id="act-title" className="font-bold">
                  Actividad reciente
                </h2>
                <Link to="/tasks" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                  Ver tareas <ArrowRight className="size-3" aria-hidden />
                </Link>
              </div>
              {d.recentActivity.length === 0 ? (
                <p className="mt-4 text-sm text-muted">Sin movimientos todavía.</p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {d.recentActivity.map((a) => (
                    <li key={a.id} className="text-sm leading-snug">
                      <span className="font-semibold">{a.actor?.displayName ?? 'Alguien'}</span> <span className="text-ink-soft">{ACTIVITY_LABEL[a.action] ?? 'modificó'}</span>{' '}
                      <span className="font-medium">«{a.task.title}»</span>
                      {a.action === 'TASK_UPDATED' && typeof a.changes?.progress?.new === 'number' && <span className="text-ink-soft"> → {a.changes.progress.new}%</span>}
                      <span className="block text-xs text-muted">{relativeTime(a.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
