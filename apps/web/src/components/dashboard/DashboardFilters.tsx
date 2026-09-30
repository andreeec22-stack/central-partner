import { forwardRef, type ReactNode } from 'react';
import { Select } from '../ui/Field';

export interface FilterOption {
  value: string;
  label: string;
}

interface DashboardFiltersProps {
  areas: FilterOption[];
  weeks: FilterOption[];
  area: string; // '' = todas
  week: string; // '' = semana actual
  onAreaChange: (value: string) => void;
  onWeekChange: (value: string) => void;
  // The export button sits at the end of the row.
  actions?: ReactNode;
}

// One filter row above everything it scopes: cards, table and charts.
// Inline on desktop; stacked on phones with the action full width.
export const DashboardFilters = forwardRef<HTMLSelectElement, DashboardFiltersProps>(function DashboardFilters(
  { areas, weeks, area, week, onAreaChange, onWeekChange, actions },
  areaRef,
) {
  return (
    <div role="group" aria-label="Filtros del dashboard" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-card sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-ink-soft sm:max-w-64">
        Área
        <Select ref={areaRef} className="h-9" value={area} onChange={(e) => onAreaChange(e.target.value)}>
          <option value="">Todas las áreas</option>
          {areas.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-ink-soft sm:max-w-64">
        Período
        <Select className="h-9" value={week} onChange={(e) => onWeekChange(e.target.value)} disabled={weeks.length === 0}>
          {weeks.length === 0 && <option value="">Semana actual</option>}
          {weeks.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
      </label>
      {actions && <div className="sm:ml-auto [&>*]:w-full sm:[&>*]:w-auto">{actions}</div>}
    </div>
  );
});
