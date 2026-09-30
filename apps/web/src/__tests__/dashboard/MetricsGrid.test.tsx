import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricsGrid, type DashboardMetrics } from '../../components/dashboard/MetricsGrid';

const metrics: DashboardMetrics = {
  index: 76,
  totalTasks: 287,
  completedTasks: 203,
  overdueTasks: 18,
  metric1: 76,
  metric2: 92,
  metric3: null,
  indexDelta: -2,
};

describe('MetricsGrid', () => {
  it('renders the seven cards', () => {
    render(<MetricsGrid metrics={metrics} />);
    const names = screen.getAllByRole('article').map((a) => a.querySelector('h3')!.textContent);
    expect(names).toEqual(['Índice General', 'Total Tareas', 'Completadas', 'Atrasadas', '① Avance', '② KPIs', '③ Funciones']);
  });

  it('colors each percentage by the thresholds and shows the weekly trend', () => {
    render(<MetricsGrid metrics={metrics} />);
    const card = (name: string) => screen.getByRole('article', { name: new RegExp(`^${name}`) });
    expect(within(card('Índice General')).getByRole('img', { name: 'En riesgo' })).toBeInTheDocument();
    expect(card('Índice General')).toHaveAccessibleName(/baja 2 pts/);
    expect(within(card('② KPIs')).getByRole('img', { name: 'En meta' })).toBeInTheDocument();
    expect(within(card('③ Funciones')).getByRole('img', { name: 'Sin datos aún' })).toBeInTheDocument();
    expect(card('Completadas')).toHaveTextContent('71% del total');
  });

  it('shows skeletons while loading', () => {
    render(<MetricsGrid metrics={null} loading />);
    expect(screen.getAllByRole('status')).toHaveLength(7);
  });
});
