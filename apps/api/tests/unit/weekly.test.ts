import { addDays, isLastSaturdayOfMonth, isoWeek, localDay, mondayOf, mondayOfDay, saturdayOf, weekdayIndex } from '../../src/lib/week';
import { areaMetrics, kpiCompletion, taskSemaphore } from '../../src/lib/weekly-metrics';

const TZ = 'America/Lima'; // UTC-5, no DST

describe('week calendar', () => {
  it('finds the Monday in the workspace timezone', () => {
    // Monday 2026-09-28 03:00 UTC is still Sunday 22:00 in Lima.
    expect(localDay(new Date('2026-09-28T03:00:00Z'), TZ)).toBe('2026-09-27');
    expect(mondayOf(new Date('2026-09-28T03:00:00Z'), TZ)).toBe('2026-09-21');
    expect(mondayOf(new Date('2026-09-28T05:00:00Z'), TZ)).toBe('2026-09-28');
    expect(mondayOfDay('2026-10-03')).toBe('2026-09-28'); // Saturday
    expect(mondayOfDay('2026-10-04')).toBe('2026-09-28'); // Sunday belongs to the same week
    expect(weekdayIndex('2026-09-28')).toBe(0);
    expect(saturdayOf('2026-09-28')).toBe('2026-10-03');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('numbers weeks the ISO way', () => {
    expect(isoWeek('2026-09-21')).toEqual({ weekNumber: 39, year: 2026 });
    expect(isoWeek('2026-12-28')).toEqual({ weekNumber: 53, year: 2026 });
    expect(isoWeek('2027-01-04')).toEqual({ weekNumber: 1, year: 2027 });
    expect(isoWeek('2024-12-30')).toEqual({ weekNumber: 1, year: 2025 });
  });

  it('spots the last Saturday of the month', () => {
    expect(isLastSaturdayOfMonth('2026-09-26')).toBe(true);
    expect(isLastSaturdayOfMonth('2026-09-19')).toBe(false);
    expect(isLastSaturdayOfMonth('2026-10-31')).toBe(true);
  });
});

describe('task semaphore by date', () => {
  const due = (iso: string | null, progress = 50) => ({ progress, dueDate: iso ? new Date(iso) : null });
  const today = '2026-09-30'; // Wednesday
  it.each([
    ['done, whatever the day', due('2026-09-28T17:00:00Z', 100), 'GREEN'],
    ['day passed below 100%', due('2026-09-29T17:00:00Z'), 'RED'],
    ['due today', due('2026-09-30T17:00:00Z'), 'YELLOW'],
    ['not due yet', due('2026-10-01T17:00:00Z'), 'GRAY'],
    ['undated: due Saturday', due(null), 'GRAY'],
  ])('%s', (_label, task, expected) => {
    expect(taskSemaphore(task, '2026-09-28', today, TZ)).toBe(expected);
  });
  it('uses the local day, not the UTC one', () => {
    // 2026-10-01 02:00 UTC = Sept 30, 21:00 in Lima → due today.
    expect(taskSemaphore(due('2026-10-01T02:00:00Z'), '2026-09-28', today, TZ)).toBe('YELLOW');
  });
  it('an undated task turns red after its Saturday', () => {
    expect(taskSemaphore(due(null), '2026-09-21', today, TZ)).toBe('RED');
  });
});

describe('KPI completion', () => {
  it('real ÷ meta, and meta ÷ real when less is better', () => {
    expect(kpiCompletion(100, 85, false)).toBe(0.85);
    expect(kpiCompletion(100, 120, false)).toBe(1.2);
    expect(kpiCompletion(100, null, false)).toBeNull();
    expect(kpiCompletion(5, 3, true)).toBe(1); // 3 tardanzas, max 5
    expect(kpiCompletion(5, 10, true)).toBe(0.5);
    expect(kpiCompletion(0, 0, true)).toBe(1); // 0 multas allowed, 0 happened
    expect(kpiCompletion(0, 2, true)).toBe(0);
  });
});

describe('area index', () => {
  const base = { weekMonday: '2026-09-28', today: '2026-10-03', timeZone: TZ };
  const task = (day: string, progress: number) => ({ progress, dueDate: new Date(`${day}T17:00:00Z`) });

  it('averages ①②③ with exact decimals', () => {
    const m = areaMetrics({
      ...base,
      tasks: [task('2026-09-28', 100), task('2026-09-29', 50), task('2026-10-02', 75), task('2026-10-05', 0)],
      kpis: [
        { target: 100, actual: 85, lesserIsBetter: false },
        { target: 15, actual: 18, lesserIsBetter: false }, // 120% counts as 100%
        { target: 10, actual: null, lesserIsBetter: false }, // not recorded: ignored
      ],
      functions: [{ fulfilled: 'YES' }, { fulfilled: 'PARTIAL' }, { fulfilled: 'NO' }, { fulfilled: 'NOT_APPLICABLE' }, { fulfilled: null }],
    });
    expect(m.taskProgress).toBe(0.75); // (1 + .5 + .75) / 3 — the task due next Monday is not counted
    expect(m.kpiCompliance).toBe(0.925);
    expect(m.functionCompliance).toBe(0.5);
    expect(m.index).toBe(0.725);
    expect(m.semaphore).toBe('YELLOW');
    expect(m.tasks).toEqual({ total: 4, due: 3, done: 1, overdue: 2, blocked: 0 });
    expect(m.kpis).toEqual({ total: 3, recorded: 2 });
    expect(m.functions).toEqual({ total: 5, marked: 4 });
  });

  it('mid-week the index is just ① until KPIs and functions are filled', () => {
    const m = areaMetrics({ ...base, today: '2026-09-29', tasks: [task('2026-09-28', 100), task('2026-09-29', 75)], kpis: [], functions: [] });
    expect(m.taskProgress).toBe(0.875);
    expect(m.kpiCompliance).toBeNull();
    expect(m.index).toBe(0.875);
    expect(m.semaphore).toBe('YELLOW');
  });

  it('thresholds: ≥90% green, 70–89% yellow, <70% red, nothing yet → none', () => {
    const at = (p: number) => areaMetrics({ ...base, tasks: [task('2026-09-28', p)], kpis: [], functions: [] }).semaphore;
    expect(at(100)).toBe('GREEN');
    expect(at(75)).toBe('YELLOW');
    expect(at(50)).toBe('RED');
    expect(areaMetrics({ ...base, tasks: [], kpis: [], functions: [] }).semaphore).toBeNull();
  });
});
