import { expectedFraction, keyResultProgress, okrProgress, okrStatus, quarterBounds } from '../../src/modules/okrs/okr-progress';
import { canCheckIn, canManageOkr, canSeeOkr } from '../../src/modules/okrs/okrs.access';
import { previousPeriods, targetStatus } from '../../src/modules/scorecard/scorecard.service';
import type { AuthUser } from '../../src/types';

describe('key result and OKR progress', () => {
  it('measures from start to target, clamped to 0–100', () => {
    expect(keyResultProgress({ startValue: 0, target: 10, current: 4 })).toBe(40);
    expect(keyResultProgress({ startValue: 50, target: 90, current: 70 })).toBe(50);
    expect(keyResultProgress({ startValue: 0, target: 10, current: 15 })).toBe(100);
    expect(keyResultProgress({ startValue: 0, target: 10, current: -3 })).toBe(0);
  });

  it('handles "lower is better" (target below start) and degenerate targets', () => {
    // churn 8% → 5%: at 6.5% we are halfway.
    expect(keyResultProgress({ startValue: 8, target: 5, current: 6.5 })).toBe(50);
    expect(keyResultProgress({ startValue: 8, target: 5, current: 9 })).toBe(0);
    expect(keyResultProgress({ startValue: 5, target: 5, current: 5 })).toBe(100);
    expect(keyResultProgress({ startValue: 5, target: 5, current: 4 })).toBe(0);
  });

  it('an OKR is the mean of its key results', () => {
    expect(okrProgress([{ startValue: 0, target: 10, current: 10 }, { startValue: 0, target: 4, current: 1 }])).toBe(62.5);
    expect(okrProgress([])).toBe(0);
  });
});

describe('OKR status by time elapsed (Phase 2 decision)', () => {
  it('quarters have the right bounds, across the year end', () => {
    expect(quarterBounds('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(quarterBounds('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('expects progress in proportion to the window, deadline included', () => {
    expect(expectedFraction('2026-Q4', null, '2026-10-01')).toBeCloseTo(1 / 92, 3);
    expect(expectedFraction('2026-Q4', null, '2026-11-15')).toBeCloseTo(46 / 92, 3);
    expect(expectedFraction('2026-Q4', '2026-10-31', '2026-10-16')).toBeCloseTo(16 / 31, 3);
    expect(expectedFraction('2026-Q4', null, '2027-02-01')).toBe(1);
  });

  it('is not "at risk" just because the quarter started', () => {
    expect(okrStatus(0, '2026-Q4', null, '2026-10-05')).toBe('ON_TRACK');
    expect(okrStatus(5, '2026-Q4', null, '2026-10-09')).toBe('ON_TRACK');
  });

  it('mid quarter: ≥70% of expected on track, 40–70% at risk, below that off track', () => {
    // 2026-11-15 → ~50% expected.
    expect(okrStatus(40, '2026-Q4', null, '2026-11-15')).toBe('ON_TRACK');
    expect(okrStatus(30, '2026-Q4', null, '2026-11-15')).toBe('AT_RISK');
    expect(okrStatus(15, '2026-Q4', null, '2026-11-15')).toBe('OFF_TRACK');
  });

  it('completed at 100; off track once the window ends unfinished', () => {
    expect(okrStatus(100, '2026-Q4', null, '2026-10-02')).toBe('COMPLETED');
    expect(okrStatus(95, '2026-Q4', '2026-11-30', '2026-12-01')).toBe('OFF_TRACK');
    expect(okrStatus(95, '2026-Q4', null, '2026-12-31')).toBe('ON_TRACK');
  });
});

describe('OKR permissions', () => {
  const user = (role: AuthUser['role'], id: string, departmentId: string | null): AuthUser => ({
    id,
    role,
    departmentId,
    workspaceId: 'ws',
    sessionId: 's',
    canCreateTasks: false,
    email: `${id}@x`,
    displayName: id,
    timezone: 'UTC',
    workspaceTimezone: 'America/Lima',
  });
  const company = { level: 'COMPANY' as const, departmentId: null, ownerUserId: null };
  const area = { level: 'AREA' as const, departmentId: 'mkt', ownerUserId: null };
  const anaOkr = { level: 'PERSON' as const, departmentId: 'mkt', ownerUserId: 'ana', owner: { role: 'USER' as const } };
  const peerOkr = { level: 'PERSON' as const, departmentId: 'mkt', ownerUserId: 'jefe-b', owner: { role: 'JEFE_AREA' as const } };

  it('company objectives: only the director manages; everyone reads', () => {
    expect(canManageOkr(user('ADMIN', 'dir', null), company)).toBe(true);
    expect(canManageOkr(user('JEFE_AREA', 'jefe', 'mkt'), company)).toBe(false);
    expect(canSeeOkr(user('VIEWER', 'lector', 'mkt'), company)).toBe(true);
  });

  it('area objectives: heads of that area manage them', () => {
    expect(canManageOkr(user('JEFE_AREA', 'jefe', 'mkt'), area)).toBe(true);
    expect(canManageOkr(user('JEFE_AREA', 'jefe-fin', 'fin'), area)).toBe(false);
    expect(canManageOkr(user('USER', 'ana', 'mkt'), area)).toBe(false);
  });

  it('personal objectives: the person and their head; never a peer head (CR-01 rule)', () => {
    expect(canSeeOkr(user('USER', 'ana', 'mkt'), anaOkr)).toBe(true);
    expect(canCheckIn(user('USER', 'ana', 'mkt'), anaOkr)).toBe(true);
    expect(canManageOkr(user('USER', 'ana', 'mkt'), anaOkr)).toBe(false);
    expect(canSeeOkr(user('USER', 'luis', 'mkt'), anaOkr)).toBe(false);
    expect(canManageOkr(user('JEFE_AREA', 'jefe', 'mkt'), anaOkr)).toBe(true);
    expect(canSeeOkr(user('JEFE_AREA', 'jefe-a', 'mkt'), peerOkr)).toBe(false);
    expect(canManageOkr(user('ADMIN', 'dir', null), peerOkr)).toBe(true);
    expect(canCheckIn(user('VIEWER', 'lector', 'mkt'), area)).toBe(false);
  });
});

describe('scorecard helpers', () => {
  it('compares an area with its target: on target, within 10 points, below, no data', () => {
    expect([85, 80, 75, 69, null].map((v) => targetStatus(v, 80))).toEqual(['ON_TARGET', 'ON_TARGET', 'AT_RISK', 'BELOW', 'NO_DATA']);
  });

  it('lists the previous quarters oldest first, across years', () => {
    expect(previousPeriods('2026-Q2', 4)).toEqual(['2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2']);
  });
});
