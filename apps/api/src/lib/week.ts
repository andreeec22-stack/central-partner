// Calendar helpers for the weekly cycle. A week runs Monday–Saturday in the
// workspace timezone and is identified by its Monday as a plain "YYYY-MM-DD"
// date. Days are compared as strings, which sort correctly in that format.

const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar day of an instant in `timeZone`, as YYYY-MM-DD.
export function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// A YYYY-MM-DD day as a UTC-midnight Date (what Prisma uses for @db.Date).
export const dayToDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
export const dateToDay = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return dateToDay(new Date(dayToDate(day).getTime() + n * DAY_MS));
}

// 0 = Monday … 6 = Sunday
export const weekdayIndex = (day: string) => (dayToDate(day).getUTCDay() + 6) % 7;

export const mondayOfDay = (day: string) => addDays(day, -weekdayIndex(day));
export const mondayOf = (instant: Date, timeZone: string) => mondayOfDay(localDay(instant, timeZone));
export const saturdayOf = (monday: string) => addDays(monday, 5);

// ISO-8601 week number and week-based year of the week starting on `monday`.
export function isoWeek(monday: string): { weekNumber: number; year: number } {
  const thursday = dayToDate(addDays(monday, 3));
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  return { weekNumber: Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1, year };
}

// The monthly "Exponer resultados" ritual falls on the last Saturday of a month.
export function isLastSaturdayOfMonth(saturday: string): boolean {
  return addDays(saturday, 7).slice(0, 7) !== saturday.slice(0, 7);
}
