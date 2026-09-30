import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricCard } from '../../components/dashboard/MetricCard';
import { SemaphoreIcon, semaphoreForPercent, toSemaphoreType } from '../../components/shared/SemaphoreIcon';

describe('SemaphoreIcon', () => {
  it.each([
    ['green', '🟢', 'En meta'],
    ['yellow', '🟡', 'En riesgo'],
    ['red', '🔴', 'Crítico'],
    ['gray', '⚪', 'Sin datos aún'],
  ] as const)('%s shows %s and reads "%s"', (type, emoji, label) => {
    render(<SemaphoreIcon type={type} />);
    const icon = screen.getByRole('img', { name: label });
    expect(icon).toHaveTextContent(emoji);
  });

  it('maps API values and percentages with the ≥90 / 70–89 / <70 rule', () => {
    expect([toSemaphoreType('GREEN'), toSemaphoreType('YELLOW'), toSemaphoreType('RED'), toSemaphoreType(null)]).toEqual(['green', 'yellow', 'red', 'gray']);
    expect([90, 89.9, 70, 69.9, null].map(semaphoreForPercent)).toEqual(['green', 'yellow', 'yellow', 'red', 'gray']);
  });
});

describe('MetricCard', () => {
  it('shows label, value with unit, semaphore and trend', () => {
    render(<MetricCard label="Índice General" value={72.5} unit="%" semaphore="yellow" trend="up" trendValue="3 pts" />);
    const card = screen.getByRole('article', { name: /Índice General: 72,5%, sube 3 pts/ });
    expect(card).toHaveTextContent('72,5');
    expect(screen.getByRole('img', { name: 'En riesgo' })).toBeInTheDocument();
  });

  it('shows a dash (and no unit) when there is nothing to measure yet', () => {
    render(<MetricCard label="② KPIs" value={null} unit="%" semaphore="gray" />);
    expect(screen.getByRole('article', { name: '② KPIs: —' })).toHaveTextContent('—');
  });

  it('renders a skeleton while loading', () => {
    render(<MetricCard label="Total Tareas" value={287} loading />);
    expect(screen.getByRole('status', { name: 'Cargando Total Tareas' })).toBeInTheDocument();
    expect(screen.queryByText('287')).not.toBeInTheDocument();
  });
});
