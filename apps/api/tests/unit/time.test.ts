import { isValidTimeZone, weekRange } from '../../src/lib/time';

describe('weekRange', () => {
  // Wednesday 2026-09-30 02:00 UTC is still Tuesday evening in Bogotá (UTC-5).
  const now = new Date('2026-09-30T02:00:00Z');

  it('uses Monday-to-Monday weeks in the user timezone', () => {
    const { start, end } = weekRange('this', 'America/Bogota', now);
    expect(start.toISOString()).toBe('2026-09-28T05:00:00.000Z'); // Mon 00:00 Bogotá
    expect(end.toISOString()).toBe('2026-10-05T05:00:00.000Z');
  });

  it('shifts one week back and forward', () => {
    expect(weekRange('last', 'UTC', now).start.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(weekRange('next', 'UTC', now).start.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  it('resolves the week from the local date, not the UTC date', () => {
    // Monday 2026-09-28 03:00 UTC is Sunday 22:00 in Bogotá → previous week.
    const sundayNightLocal = new Date('2026-09-28T03:00:00Z');
    expect(weekRange('this', 'America/Bogota', sundayNightLocal).start.toISOString()).toBe('2026-09-21T05:00:00.000Z');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimeZone('America/Bogota')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
