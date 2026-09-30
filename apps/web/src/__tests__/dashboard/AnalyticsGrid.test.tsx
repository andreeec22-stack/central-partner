import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsGrid } from '../../components/dashboard/AnalyticsGrid';
import { AreaChartCompliance } from '../../components/dashboard/AreaChartCompliance';
import { BarChartDelayed } from '../../components/dashboard/BarChartDelayed';
import { LineChartGeneral } from '../../components/dashboard/LineChartGeneral';
import type { HistoryPoint } from '../../lib/dashboard';

const point = (n: number, index: number | null, completed: number, total: number, delayed: number, current = false): HistoryPoint => ({
  weekId: `w${n}`,
  label: `S${n}`,
  range: '',
  index,
  semaphore: index === null ? 'gray' : index >= 90 ? 'green' : index >= 70 ? 'yellow' : 'red',
  completed,
  total,
  delayed,
  compliance: total ? Math.round((completed / total) * 1000) / 10 : null,
  current,
});

// The spec's reference weeks.
const points = [point(38, 78.2, 34, 42, 8), point(39, 82.5, 38, 42, 4), point(40, 85.5, 38, 42, 0, true)];

// Every chart ships a table twin; tests read the numbers from it.
const tableOf = (title: string) => within(screen.getByRole('region', { name: title })).getByRole('table');
const rowsOf = (title: string) =>
  within(tableOf(title))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

describe('AnalyticsGrid', () => {
  it('renders the four charts, each with a text alternative', () => {
    render(<AnalyticsGrid points={points} selectedWeekId="w40" />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Índice General',
      'Tareas Completadas',
      'Tareas Atrasadas',
      'Tendencia de Cumplimiento',
    ]);
    expect(screen.getByRole('img', { name: /^Índice General por semana: S38 78,2% \(en riesgo\), S39 82,5%/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /S38 34 de 42/ })).toBeInTheDocument();
  });

  it('shows skeletons while loading and an error with retry', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<AnalyticsGrid points={[]} loading />);
    expect(screen.getAllByRole('status')).toHaveLength(4);
    rerender(<AnalyticsGrid points={[]} error onRetry={onRetry} />);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Error cargando datos históricos');
    await userEvent.click(screen.getAllByRole('button', { name: 'Reintentar' })[0]!);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('LineChartGeneral', () => {
  it('plots each week’s index with its semaphore', () => {
    render(<LineChartGeneral points={points} />);
    expect(rowsOf('Índice General')).toEqual([
      ['S38', '78,2%', 'en riesgo'],
      ['S39', '82,5%', 'en riesgo'],
      ['S40 (actual)', '85,5%', 'en riesgo'],
    ]);
  });

  it('switches to the table view for everyone', async () => {
    render(<LineChartGeneral points={points} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver tabla' }));
    expect(screen.queryByRole('img', { name: /Índice General por semana/ })).not.toBeInTheDocument();
    expect(tableOf('Índice General')).not.toHaveClass('sr-only');
  });
});

describe('BarChartDelayed', () => {
  it('draws no bar for a week without delays', () => {
    const { container } = render(<BarChartDelayed points={points} />);
    expect(rowsOf('Tareas Atrasadas').map((r) => r[1])).toEqual(['8', '4', '0']);
    expect(container.querySelectorAll('.recharts-bar-rectangle path')).toHaveLength(2);
  });

  it('says so when no week has delays', () => {
    render(<BarChartDelayed points={points.map((p) => ({ ...p, delayed: 0 }))} />);
    expect(screen.getByText('Sin tareas atrasadas')).toBeInTheDocument();
  });
});

describe('AreaChartCompliance', () => {
  it('uses a fixed 0–100% axis with the 70% threshold', () => {
    const { container } = render(<AreaChartCompliance points={points} />);
    const ticks = [...container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick-value')].map((t) => t.textContent);
    expect(ticks).toEqual(['0%', '25%', '50%', '70%', '100%']);
    expect(rowsOf('Tendencia de Cumplimiento').map((r) => r[1])).toEqual(['81%', '90,5%', '90,5%']);
  });

  it('shows "Sin datos disponibles" when nothing can be plotted', () => {
    render(<AreaChartCompliance points={[point(40, null, 0, 0, 0, true)]} />);
    expect(screen.getByText('Sin datos disponibles')).toBeInTheDocument();
  });
});
