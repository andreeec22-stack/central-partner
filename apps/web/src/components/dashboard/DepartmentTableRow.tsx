import clsx from 'clsx';
import { formatPercent } from '../../lib/format';
import { SemaphoreIcon, type SemaphoreType } from '../shared/SemaphoreIcon';

// One area of the weekly detail table. Percentages 0–100, null = not measurable yet.
export interface DepartmentRow {
  id: string;
  name: string;
  color?: string | null;
  boss: string | null;
  totalTasks: number;
  completion: number; // completed tasks (count)
  overdue: number;
  metric1: number | null; // ①
  metric2: number | null; // ②
  metric3: number | null; // ③
  departmentIndex: number | null;
  semaphore: SemaphoreType;
}

const num = 'px-3 py-3 text-right tabular whitespace-nowrap';

export function DepartmentTableRow({ row, onRowClick }: { row: DepartmentRow; onRowClick?: (id: string) => void }) {
  const open = () => onRowClick?.(row.id);
  return (
    <tr onClick={onRowClick ? open : undefined} className={clsx('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-paper/70')}>
      <th scope="row" className="sticky left-0 z-[1] bg-surface px-4 py-3 text-left font-semibold">
        {/* The name is the keyboard target; the whole row is the mouse target. */}
        {onRowClick ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="inline-flex items-center gap-2 text-left hover:text-brand hover:underline"
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: row.color ?? 'var(--color-line-strong)' }} />
            {row.name}
          </button>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: row.color ?? 'var(--color-line-strong)' }} />
            {row.name}
          </span>
        )}
      </th>
      <td className="px-3 py-3 whitespace-nowrap text-ink-soft">{row.boss ?? <span className="text-muted">Sin jefe</span>}</td>
      <td className={num}>{row.totalTasks}</td>
      <td className={num}>
        {row.completion}
        <span className="text-muted">/{row.totalTasks}</span>
      </td>
      <td className={clsx(num, row.overdue > 0 ? 'font-semibold text-sem-red' : 'text-muted')}>{row.overdue}</td>
      <td className={num}>{formatPercent(row.metric1)}</td>
      <td className={num}>{formatPercent(row.metric2)}</td>
      <td className={num}>{formatPercent(row.metric3)}</td>
      <td className={clsx(num, 'font-extrabold')}>{formatPercent(row.departmentIndex)}</td>
      <td className="px-3 py-2 text-center">
        <SemaphoreIcon type={row.semaphore} size="sm" />
      </td>
    </tr>
  );
}
