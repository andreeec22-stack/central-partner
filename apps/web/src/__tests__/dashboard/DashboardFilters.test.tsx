import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardFilters } from '../../components/dashboard/DashboardFilters';

const areas = [
  { value: 'marketing', label: 'Marketing' },
  { value: 'community', label: 'Community' },
];
const weeks = [
  { value: '', label: 'Semana actual (S40)' },
  { value: '39', label: '-1 semana (S39)' },
];

describe('DashboardFilters', () => {
  it('offers "Todas las áreas" plus each area, and the available weeks', () => {
    render(<DashboardFilters areas={areas} weeks={weeks} area="" week="" onAreaChange={vi.fn()} onWeekChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Área' })).toHaveDisplayValue('Todas las áreas');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Todas las áreas',
      'Marketing',
      'Community',
      'Semana actual (S40)',
      '-1 semana (S39)',
    ]);
  });

  it('reports changes to the parent', async () => {
    const onAreaChange = vi.fn();
    const onWeekChange = vi.fn();
    render(<DashboardFilters areas={areas} weeks={weeks} area="" week="" onAreaChange={onAreaChange} onWeekChange={onWeekChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Área' }), 'community');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Período' }), '39');
    expect(onAreaChange).toHaveBeenCalledWith('community');
    expect(onWeekChange).toHaveBeenCalledWith('39');
  });

  it('is reachable with Tab in order: área, período, action', async () => {
    render(
      <DashboardFilters areas={areas} weeks={weeks} area="" week="" onAreaChange={vi.fn()} onWeekChange={vi.fn()} actions={<button type="button">Exportar</button>} />,
    );
    await userEvent.tab();
    expect(screen.getByRole('combobox', { name: 'Área' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('combobox', { name: 'Período' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Exportar' })).toHaveFocus();
  });
});
