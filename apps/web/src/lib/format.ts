// Dates come from the API in UTC and are shown in the user's own timezone (Gap 14).

export function formatDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', timeZone }).format(new Date(iso));
}

export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

// "Is this date before today in the user's timezone?" — for overdue marks.
export function isOverdue(dueIso: string | null, timeZone: string, now: Date = new Date()): boolean {
  if (!dueIso) return false;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d); // YYYY-MM-DD
  return day(new Date(dueIso)) < day(now);
}

// <input type="date"> value (YYYY-MM-DD) → ISO instant at local noon, so the
// calendar day survives any timezone shift.
export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T12:00:00`).toISOString();
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
