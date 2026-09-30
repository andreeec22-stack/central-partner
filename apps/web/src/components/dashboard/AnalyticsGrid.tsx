import { AreaChartCompliance } from './AreaChartCompliance';
import { BarChartDelayed } from './BarChartDelayed';
import { BarChartTasks } from './BarChartTasks';
import { LineChartGeneral, type HistoryChartProps } from './LineChartGeneral';

// The four history charts: 2×2 from tablet up, stacked on phones. They all
// plot the same weeks, filtered by area; the selected week is highlighted.
export function AnalyticsGrid(props: HistoryChartProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <LineChartGeneral {...props} />
      <BarChartTasks {...props} />
      <BarChartDelayed {...props} />
      <AreaChartCompliance {...props} />
    </div>
  );
}
