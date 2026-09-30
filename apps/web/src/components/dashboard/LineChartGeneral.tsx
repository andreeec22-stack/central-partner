import { useId, useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryPoint } from '../../lib/dashboard';
import { axisProps, CHART, ChartCard, CRITICAL_THRESHOLD, SEMAPHORE_COLOR } from './charts/ChartCard';
import { ChartTooltip, pct } from './charts/ChartTooltip';

export interface HistoryChartProps {
  points: HistoryPoint[];
  selectedWeekId?: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

const SEMAPHORE_TEXT = { green: 'en meta', yellow: 'en riesgo', red: 'crítico', gray: 'sin datos' };

// Índice General week by week: a line over a soft area, each point colored by
// its semaphore, with the 70% "crítico" line for reference.
export function LineChartGeneral({ points, selectedWeekId, loading, error, onRetry }: HistoryChartProps) {
  const gradient = useId().replace(/:/g, '');
  const selected = points.find((p) => p.weekId === selectedWeekId)?.label;
  const last = points.at(-1);
  const summary = useMemo(
    () => `Índice General por semana: ${points.map((p) => `${p.label} ${pct(p.index)} (${SEMAPHORE_TEXT[p.semaphore]})`).join(', ')}.`,
    [points],
  );

  return (
    <ChartCard
      title="Índice General"
      description="(① + ② + ③) ÷ 3, semana a semana"
      summary={summary}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && points.every((p) => p.index === null) ? 'Sin datos disponibles' : null}
      legend={[
        { label: 'Índice', color: CHART.blue, shape: 'line' },
        { label: 'Umbral crítico 70%', color: CHART.threshold, shape: 'dash' },
      ]}
      table={{
        rows: points as unknown as Record<string, unknown>[],
        columns: [
          { label: 'Semana', value: (r) => `${r.label}${r.current ? ' (actual)' : ''}` },
          { label: 'Índice', value: (r) => pct(r.index as number | null) },
          { label: 'Semáforo', value: (r) => SEMAPHORE_TEXT[r.semaphore as HistoryPoint['semaphore']] },
        ],
      }}
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 240 }}>
        <ComposedChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.blue} stopOpacity={0.22} />
              <stop offset="100%" stopColor={CHART.blue} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={CHART.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 70, 100]} unit="%" width={48} {...axisProps} />
          <ReferenceLine y={CRITICAL_THRESHOLD} stroke={CHART.threshold} strokeDasharray="4 4" strokeWidth={1.5} />
          <Tooltip cursor={{ stroke: CHART.grid, strokeWidth: 1 }} content={<ChartTooltip rows={(p) => [{ label: 'Índice', value: pct(p.index), color: SEMAPHORE_COLOR[p.semaphore] }]} />} />
          <Area type="monotone" dataKey="index" stroke="none" fill={`url(#${gradient})`} isAnimationActive={false} connectNulls />
          <Line
            type="monotone"
            dataKey="index"
            stroke={CHART.blue}
            strokeWidth={2}
            connectNulls
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; payload?: HistoryPoint; index?: number }) =>
              props.cx === undefined || props.cy === undefined || props.payload?.index === null ? (
                <g key={props.index} />
              ) : (
                // The week chosen in the period filter gets a larger dot with a ring.
                <g key={props.index}>
                  {props.payload!.label === selected && <circle cx={props.cx} cy={props.cy} r={10} fill="none" stroke={CHART.blue} strokeOpacity={0.35} strokeWidth={2} />}
                  <circle cx={props.cx} cy={props.cy} r={props.payload!.label === selected ? 6 : 5} fill={SEMAPHORE_COLOR[props.payload!.semaphore]} stroke="#fff" strokeWidth={2} />
                </g>
              )
            }
            activeDot={{ r: 7, stroke: '#fff', strokeWidth: 2 }}
            label={(props: { x?: number; y?: number; index?: number }) =>
              // Direct label on the latest week only.
              props.index === points.length - 1 && last?.index !== null && props.x !== undefined && props.y !== undefined ? (
                <text key="last" x={props.x} y={props.y - 12} textAnchor="middle" fontSize={12} fontWeight={700} fill="#1b2130">
                  {pct(last!.index)}
                </text>
              ) : (
                <g key={props.index} />
              )
            }
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
