import { DepartmentTableRow, type DepartmentRow } from './DepartmentTableRow';

interface DepartmentTableProps {
  departments: DepartmentRow[];
  loading?: boolean;
  onRowClick?: (departmentId: string) => void;
}

const HEADERS: { label: string; title?: string; align: 'left' | 'right' | 'center' }[] = [
  { label: 'Área', align: 'left' },
  { label: 'Jefe', align: 'left' },
  { label: 'Tareas', align: 'right' },
  { label: 'Cumpl.', title: 'Tareas completadas', align: 'right' },
  { label: 'Atraso', title: 'Tareas atrasadas', align: 'right' },
  { label: '①', title: 'Avance de tareas', align: 'right' },
  { label: '②', title: 'Cumplimiento de KPIs', align: 'right' },
  { label: '③', title: 'Funciones cumplidas', align: 'right' },
  { label: 'Índice', title: '(① + ② + ③) ÷ 3', align: 'right' },
  { label: 'Semáforo', align: 'center' },
];

function DepartmentTableSkeleton() {
  return (
    <div role="status" aria-label="Cargando áreas" className="space-y-2 rounded-2xl border border-line bg-surface p-4 shadow-card">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-sunken" />
      ))}
    </div>
  );
}

// On phones the table scrolls sideways inside its card, with the area name pinned.
export function DepartmentTable({ departments, loading = false, onRowClick }: DepartmentTableProps) {
  if (loading) return <DepartmentTableSkeleton />;
  if (departments.length === 0) {
    return <p className="rounded-2xl border border-dashed border-line-strong bg-surface/60 px-4 py-10 text-center text-sm text-muted">No hay áreas para mostrar.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-card">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <caption className="sr-only">Detalle por área: tareas, métricas ①②③, índice y semáforo</caption>
        <thead className="border-b border-line bg-paper/70 text-xs font-semibold uppercase tracking-wide text-muted">
          <tr>
            {HEADERS.map((h, i) => (
              <th
                key={h.label}
                scope="col"
                title={h.title}
                className={
                  (i === 0 ? 'sticky left-0 z-[1] bg-paper px-4 ' : 'px-3 ') +
                  `py-2.5 whitespace-nowrap ${h.align === 'right' ? 'text-right' : h.align === 'center' ? 'text-center' : 'text-left'}`
                }
              >
                {h.title ? (
                  <>
                    <span aria-hidden>{h.label}</span>
                    <span className="sr-only">{h.title}</span>
                  </>
                ) : (
                  h.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {departments.map((dept) => (
            <DepartmentTableRow key={dept.id} row={dept} onRowClick={onRowClick} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
