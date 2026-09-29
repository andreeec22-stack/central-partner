// WhatsApp delivery window. Nothing is sent 21:00–07:00 in the recipient's
// timezone, nor inside their own quiet hours ("HH:mm"–"HH:mm", may wrap midnight).

export const DELIVERY_START_MINUTE = 7 * 60;
export const DELIVERY_END_MINUTE = 21 * 60;

export function minuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function inRange(minute: number, start: number, end: number) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isQuietTime(
  now: Date,
  timeZone: string,
  quietStart?: string | null,
  quietEnd?: string | null,
): boolean {
  const minute = minuteOfDay(now, timeZone);
  if (minute < DELIVERY_START_MINUTE || minute >= DELIVERY_END_MINUTE) return true;
  return !!(quietStart && quietEnd && inRange(minute, toMinutes(quietStart), toMinutes(quietEnd)));
}
