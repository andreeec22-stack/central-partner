import clsx from 'clsx';
import { LayoutDashboard, ListChecks, LogOut, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { initials } from '../../lib/format';
import { ROLE_LABEL } from '../../lib/labels';
import { useDepartments } from '../../lib/queries';
import { useRealtime, type ConnectionState } from '../../lib/realtime';
import { useAuth } from '../../stores/auth';

function Logo({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-white/10">
        <span className="flex gap-[3px]">
          <span className="size-1.5 rounded-full bg-sem-green" />
          <span className="size-1.5 rounded-full bg-sem-yellow" />
          <span className="size-1.5 rounded-full bg-sem-red" />
        </span>
      </span>
      <span className="truncate text-[15px] font-extrabold tracking-tight text-white">{name}</span>
    </div>
  );
}

function LiveIndicator({ state }: { state: ConnectionState }) {
  const label = state === 'live' ? 'En vivo' : state === 'connecting' ? 'Conectando…' : 'Sin conexión';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-soft" role="status" aria-live="polite">
      <span className={clsx('size-2 rounded-full', state === 'live' ? 'bg-sem-green' : state === 'connecting' ? 'bg-sem-yellow animate-pulse' : 'bg-sem-red')} />
      {label}
    </span>
  );
}

const navItem = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition',
    isActive ? 'bg-white/12 text-white' : 'text-white/70 hover:bg-white/8 hover:text-white',
  );

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const workspace = useAuth((s) => s.workspace);
  const departments = useDepartments();
  return (
    <div className="flex h-full flex-col bg-navy px-3 py-4">
      <div className="px-2 pb-6">
        <Logo name={workspace?.name ?? 'Central Partner'} />
      </div>
      <nav aria-label="Principal" className="space-y-1">
        <NavLink to="/" end className={navItem} onClick={onNavigate}>
          <LayoutDashboard className="size-4" aria-hidden /> Panel
        </NavLink>
        <NavLink to="/tasks" className={navItem} onClick={onNavigate}>
          <ListChecks className="size-4" aria-hidden /> Tareas
        </NavLink>
      </nav>

      {!!departments.data?.length && (
        <div className="mt-8">
          <p className="px-3 pb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Departamentos</p>
          <ul className="space-y-0.5">
            {departments.data.map((d) => (
              <li key={d.id}>
                <NavLink
                  to={`/tasks?department=${d.id}`}
                  onClick={onNavigate}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/8 hover:text-white"
                >
                  <span aria-hidden className="size-2 rounded-full" style={{ background: d.color ?? 'rgb(255 255 255 / 0.35)' }} />
                  <span className="truncate">{d.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const connection = useRealtime();
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

  useEffect(() => setDrawer(false), [location.pathname, location.search]);

  // Drawer: Esc closes it and the page behind doesn't scroll.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [drawer]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh lg:block">
        <Sidebar />
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <button className="absolute inset-0 bg-ink/50" onClick={() => setDrawer(false)} aria-label="Cerrar menú" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw]">
            <Sidebar onNavigate={() => setDrawer(false)} />
            <button onClick={() => setDrawer(false)} className="absolute right-3 top-4 rounded-md p-1.5 text-white/70 hover:bg-white/10" aria-label="Cerrar menú">
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-paper/85 px-4 backdrop-blur sm:px-6">
          <button onClick={() => setDrawer(true)} className="-ml-1 rounded-md p-1.5 text-ink-soft hover:bg-sunken lg:hidden" aria-label="Abrir menú">
            <Menu className="size-5" />
          </button>
          <div className="flex-1" />
          <LiveIndicator state={connection} />
          {user && (
            <div className="flex items-center gap-3 border-l border-line pl-3">
              <div className="hidden text-right sm:block">
                <p className="text-sm font-bold leading-tight">{user.displayName}</p>
                <p className="text-xs text-muted">{ROLE_LABEL[user.role]}</p>
              </div>
              <span aria-hidden className="grid size-8 place-items-center rounded-full bg-navy text-xs font-bold text-white">
                {initials(user.displayName)}
              </span>
              <button onClick={() => void logout()} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" aria-label="Cerrar sesión" title="Cerrar sesión">
                <LogOut className="size-4" />
              </button>
            </div>
          )}
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
