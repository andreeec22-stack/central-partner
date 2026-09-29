import { TZDate } from '@date-fns/tz';
import { addWeeks, startOfWeek } from 'date-fns';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type WeekFilter = 'last' | 'this' | 'next';
const WEEK_OFFSET: Record<WeekFilter, number> = { last: -1, this: 0, next: 1 };

// Monday 00:00 → next Monday 00:00 in the user's timezone, returned as UTC instants.
export function weekRange(which: WeekFilter, timeZone: string, now: Date = new Date()) {
  const zonedNow = new TZDate(now.getTime(), timeZone);
  const start = startOfWeek(addWeeks(zonedNow, WEEK_OFFSET[which]), { weekStartsOn: 1 });
  const end = addWeeks(start, 1);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}
