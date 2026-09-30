import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DepartmentTable } from '../../components/dashboard/DepartmentTable';
import type { DepartmentRow } from '../../components/dashboard/DepartmentTableRow';

const rows: DepartmentRow[] = [
  { id: 'm', name: 'MARKETING', boss: 'Molie', totalTasks: 25, completion: 18, overdue: 2, metric1: 76, metric2: 82, metric3: 88, departmentIndex: 82, semaphore: 'yellow' },
  { id: 'f', name: 'FINANZAS', boss: null, totalTasks: 30, completion: 28, overdue: 0, metric1: 93, metric2: null, metric3: null, departmentIndex: 93, semaphore: 'green' },
];

describe('DepartmentTable', () => {
  it('renders one row per area with its numbers', () => {
    render(<DepartmentTable departments={rows} />);
    const marketing = screen.getByRole('row', { name: /MARKETING/ });
    const cells = within(marketing).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['Molie', '25', '18/25', '2', '76%', '82%', '88%', '82%', '🟡']);
    expect(within(marketing).getByRole('img', { name: 'En riesgo' })).toBeInTheDocument();

    const finanzas = screen.getByRole('row', { name: /FINANZAS/ });
    expect(within(finanzas).getByText('Sin jefe')).toBeInTheDocument();
    expect(within(finanzas).getAllByText('—')).toHaveLength(2); // ② and ③ not filled yet
  });

  it('opens an area by clicking the row or with the keyboard', async () => {
    const onRowClick = vi.fn();
    render(<DepartmentTable departments={rows} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByRole('row', { name: /FINANZAS/ }).querySelector('td')!);
    expect(onRowClick).toHaveBeenLastCalledWith('f');

    screen.getByRole('button', { name: 'MARKETING' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith('m');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('shows a skeleton while loading and a message when empty', () => {
    const { rerender } = render(<DepartmentTable departments={[]} loading />);
    expect(screen.getByRole('status', { name: 'Cargando áreas' })).toBeInTheDocument();
    rerender(<DepartmentTable departments={[]} />);
    expect(screen.getByText('No hay áreas para mostrar.')).toBeInTheDocument();
  });
});
