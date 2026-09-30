import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryPoint } from '../../lib/dashboard';
import { axisProps, CHART, ChartCard } from './charts/ChartCard';
import { ChartTooltip } from './charts/ChartTooltip';
import type { HistoryChartProps } from './LineChartGeneral';

// Tareas Completadas vs total, per week (same unit, one axis).
export function BarChartTasks({ points, selectedWeekId, loading, error, onRetry }: HistoryChartProps) {
  const selected = points.find((p) => p.weekId === selectedWeekId)?.label;
  const summary = useMemo(
    () => `Tareas completadas del total por semana: ${points.map((p) => `${p.label} ${p.completed} de ${p.total}`).join(', ')}.`,
    [points],
  );

  return (
    <ChartCard
      title="Tareas Completadas"
      description="Completadas vs total de la semana"
      summary={summary}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && points.every((p) => p.total === 0) ? 'Sin datos disponibles' : null}
      legend={[
        { label: 'Completadas', color: CHART.blue },
        { label: 'Total', color: CHART.gray },
      ]}
      table={{
        rows: points as unknown as Record<string, unknown>[],
        columns: [
          { label: 'Semana', value: (r) => `${r.label}${r.current ? ' (actual)' : ''}` },
          { label: 'Completadas', value: (r) => r.completed as number },
          { label: 'Total', value: (r) => r.total as number },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 240 }}>
        <BarChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: -12 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis allowDecimals={false} width={48} {...axisProps} />
          {selected && <ReferenceArea x1={selected} x2={selected} fill={CHART.highlight} />}
          <Tooltip
            cursor={{ fill: 'rgba(27,33,48,0.04)' }}
            content={
              <ChartTooltip
                rows={(p) => [
                  { label: 'Completadas', value: `${p.completed}`, color: CHART.blue },
                  { label: 'Total', value: `${p.total}`, color: CHART.gray },
                ]}
              />
            }
          />
          <Bar dataKey="completed" name="Completadas" fill={CHART.blue} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          <Bar dataKey="total" name="Total" fill={CHART.gray} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
