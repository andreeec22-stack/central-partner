import clsx from 'clsx';
import { NavLink } from 'react-router';
import { useAuth } from '../../stores/auth';

// Sections of "Desempeño". The dashboard is for the director and area heads.
export function PerfNav() {
  const role = useAuth((s) => s.user?.role);
  const manager = role === 'ADMIN' || role === 'JEFE_AREA';
  const items = [
    { to: '/performance', label: 'Evaluaciones', end: true },
    ...(manager ? [{ to: '/performance/dashboard', label: 'Dashboard', end: false }] : []),
    { to: '/performance/okrs', label: 'Objetivos', end: false },
    { to: '/performance/reviews', label: 'Resultados', end: false },
  ];
  return (
    <nav aria-label="Secciones de desempeño" className="-mx-1 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) =>
            clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition',
              isActive ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink',
            )
          }
        >
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}
