import { useId, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axisProps, CHART, ChartCard, CRITICAL_THRESHOLD } from './charts/ChartCard';
import { ChartTooltip, pct } from './charts/ChartTooltip';
import type { HistoryChartProps } from './LineChartGeneral';

// Tendencia de Cumplimiento: % of the week's tasks completed, on a fixed 0–100 axis.
export function AreaChartCompliance({ points, selectedWeekId, loading, error, onRetry }: HistoryChartProps) {
  const gradient = useId().replace(/:/g, '');
  const selected = points.find((p) => p.weekId === selectedWeekId)?.label;
  const summary = useMemo(() => `Cumplimiento por semana: ${points.map((p) => `${p.label} ${pct(p.compliance)}`).join(', ')}.`, [points]);

  return (
    <ChartCard
      title="Tendencia de Cumplimiento"
      description="% de tareas completadas de la semana"
      summary={summary}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && points.every((p) => p.compliance === null) ? 'Sin datos disponibles' : null}
      legend={[
        { label: 'Cumplimiento', color: CHART.green, shape: 'line' },
        { label: 'Umbral crítico 70%', color: CHART.threshold, shape: 'dash' },
      ]}
      table={{
        rows: points as unknown as Record<string, unknown>[],
        columns: [
          { label: 'Semana', value: (r) => `${r.label}${r.current ? ' (actual)' : ''}` },
          { label: 'Cumplimiento', value: (r) => pct(r.compliance as number | null) },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 240 }}>
        <AreaChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.green} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART.green} stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 70, 100]} unit="%" width={48} {...axisProps} />
          <ReferenceLine y={CRITICAL_THRESHOLD} stroke={CHART.threshold} strokeDasharray="4 4" strokeWidth={1.5} />
          <Tooltip cursor={{ stroke: CHART.grid }} content={<ChartTooltip rows={(p) => [{ label: 'Cumplimiento', value: pct(p.compliance), color: CHART.green }]} />} />
          <Area
            type="monotone"
            dataKey="compliance"
            stroke={CHART.green}
            strokeWidth={2}
            fill={`url(#${gradient})`}
            connectNulls
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: { label: string; compliance: number | null } }) =>
              props.cx === undefined || props.cy === undefined || props.payload?.compliance === null ? (
                <g key={props.index} />
              ) : (
                // The week chosen in the period filter gets a larger dot with a ring.
                <g key={props.index}>
                  {props.payload?.label === selected && <circle cx={props.cx} cy={props.cy} r={10} fill="none" stroke={CHART.blue} strokeOpacity={0.35} strokeWidth={2} />}
                  <circle cx={props.cx} cy={props.cy} r={props.payload?.label === selected ? 6 : 4} fill={CHART.green} stroke="#fff" strokeWidth={2} />
                </g>
              )
            }
            activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
