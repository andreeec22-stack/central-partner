import clsx from 'clsx';
import { BookOpen, Building2, CalendarDays, ClipboardList, FileSpreadsheet, History, LayoutDashboard, ListChecks, LogOut, Menu, Settings2, ShieldCheck, TrendingUp, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useWorkspaceBranding } from '../../lib/branding';
import { initials } from '../../lib/format';
import { ROLE_LABEL } from '../../lib/labels';
import { useDepartments } from '../../lib/queries';
import { useRealtime, type ConnectionState } from '../../lib/realtime';
import { useAuth } from '../../stores/auth';
import { BrandMark } from './BrandMark';

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
  const role = useAuth((s) => s.user?.role);
  const branding = useWorkspaceBranding();
  const departments = useDepartments();
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-navy px-3 py-4">
      <div className="px-2 pb-6">
        <BrandMark name={branding?.workspaceName ?? workspace?.name ?? 'Central Partner'} logoUrl={branding?.logoUrl} tagline={branding?.tagline} />
      </div>
      <nav aria-label="Principal" className="space-y-1">
        <NavLink to="/" end className={navItem} onClick={onNavigate}>
          <LayoutDashboard className="size-4" aria-hidden /> Panel
        </NavLink>
        <NavLink to="/tasks" className={navItem} onClick={onNavigate}>
          <ListChecks className="size-4" aria-hidden /> Tareas
        </NavLink>
        {role && role !== 'VIEWER' && (
          <NavLink to="/performance" className={navItem} onClick={onNavigate}>
            <TrendingUp className="size-4" aria-hidden /> Desempeño
          </NavLink>
        )}
      </nav>

      {role === 'ADMIN' && (
        <div className="mt-8">
          <p className="px-3 pb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Administración</p>
          <nav aria-label="Administración" className="space-y-1">
            <p className="px-3 pt-1 text-[11px] font-semibold text-white/40">Settings</p>
            <NavLink to="/admin/settings/users" className={navItem} onClick={onNavigate}>
              <Users className="size-4" aria-hidden /> Usuarios
            </NavLink>
            <NavLink to="/admin/settings/permissions" className={navItem} onClick={onNavigate}>
              <ShieldCheck className="size-4" aria-hidden /> Permisos & roles
            </NavLink>
            <NavLink to="/admin/settings/departments" className={navItem} onClick={onNavigate}>
              <Building2 className="size-4" aria-hidden /> Departamentos
            </NavLink>
            <NavLink to="/admin/settings/workspace" className={navItem} onClick={onNavigate}>
              <Settings2 className="size-4" aria-hidden /> Workspace
            </NavLink>
            <p className="px-3 pt-3 text-[11px] font-semibold text-white/40">Operación</p>
            <NavLink to="/admin/weeks" className={navItem} onClick={onNavigate}>
              <CalendarDays className="size-4" aria-hidden /> Gestión de semanas
            </NavLink>
            <NavLink to="/admin/reports" className={navItem} onClick={onNavigate}>
              <FileSpreadsheet className="size-4" aria-hidden /> Reportes semanales
            </NavLink>
            <NavLink to="/admin/surveys" className={navItem} onClick={onNavigate}>
              <ClipboardList className="size-4" aria-hidden /> Plantillas de encuesta
            </NavLink>
            <NavLink to="/admin/audit" className={navItem} onClick={onNavigate}>
              <History className="size-4" aria-hidden /> Auditoría
            </NavLink>
            <NavLink to="/admin/import" className={navItem} onClick={onNavigate}>
              <FileSpreadsheet className="size-4" aria-hidden /> Importar Excel
            </NavLink>
            <NavLink to="/admin/docs" className={navItem} onClick={onNavigate}>
              <BookOpen className="size-4" aria-hidden /> Documentación
            </NavLink>
          </nav>
        </div>
      )}

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
