import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryPoint } from '../../lib/dashboard';
import { axisProps, CHART, ChartCard } from './charts/ChartCard';
import { ChartTooltip } from './charts/ChartTooltip';
import type { HistoryChartProps } from './LineChartGeneral';

// Tareas Atrasadas per week. A week with none simply has no bar.
export function BarChartDelayed({ points, selectedWeekId, loading, error, onRetry }: HistoryChartProps) {
  const selected = points.find((p) => p.weekId === selectedWeekId)?.label;
  // A zero-height bar would still draw its rounded cap: drop zeros entirely.
  const data = useMemo(() => points.map((p) => ({ ...p, delayedBar: p.delayed > 0 ? p.delayed : null })), [points]);
  const summary = useMemo(() => `Tareas atrasadas por semana: ${points.map((p) => `${p.label} ${p.delayed}`).join(', ')}.`, [points]);
  const noneDelayed = points.length > 0 && points.every((p) => p.delayed === 0);

  return (
    <ChartCard
      title="Tareas Atrasadas"
      description="Su día pasó sin llegar al 100%"
      summary={summary}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error ? (points.length === 0 ? 'Sin datos disponibles' : noneDelayed ? 'Sin tareas atrasadas' : null) : null}
      table={{
        rows: points as unknown as Record<string, unknown>[],
        columns: [
          { label: 'Semana', value: (r) => `${r.label}${r.current ? ' (actual)' : ''}` },
          { label: 'Atrasadas', value: (r) => r.delayed as number },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 240 }}>
        <BarChart data={data} margin={{ top: 20, right: 16, bottom: 0, left: -12 }} barCategoryGap="36%">
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis allowDecimals={false} width={48} {...axisProps} />
          {selected && <ReferenceArea x1={selected} x2={selected} fill={CHART.highlight} />}
          <Tooltip
            cursor={{ fill: 'rgba(27,33,48,0.04)' }}
            content={<ChartTooltip rows={(p: HistoryPoint) => [{ label: 'Atrasadas', value: `${p.delayed}`, color: CHART.red }]} />}
          />
          <Bar dataKey="delayedBar" name="Atrasadas" fill={CHART.red} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false}>
            <LabelList dataKey="delayedBar" position="top" fontSize={12} fontWeight={700} fill="#1b2130" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
