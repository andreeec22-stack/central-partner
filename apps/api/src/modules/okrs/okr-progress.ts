import { addDays, dayToDate } from '../../lib/week';

// Pure OKR arithmetic. Progress is 0–100 with one decimal.
//
// Key result:  (current − start) / (target − start), clamped to 0–100. A target
//              below the start means "lower is better" (e.g. churn 8 → 5) and
//              works with the same formula.
// OKR:         mean of its key results (equal weight).
// Status:      progress compared with how much of the OKR's window has gone
//              by — so a quarter that just started is not "at risk" for being
//              at 5% (product decision, Phase 2):
//                COMPLETED    progress ≥ 100
//                OFF_TRACK    the window ended below 100
//                ON_TRACK     ≥ 70% of the expected progress (or first 10% of the window)
//                AT_RISK      40–70% of it
//                OFF_TRACK    under 40% of it

export type OkrStatus = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'COMPLETED';

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function keyResultProgress(kr: { startValue: number; target: number; current: number }): number {
  if (kr.target === kr.startValue) return kr.current >= kr.target ? 100 : 0;
  return round1(clamp(((kr.current - kr.startValue) / (kr.target - kr.startValue)) * 100, 0, 100));
}

export function okrProgress(keyResults: { startValue: number; target: number; current: number }[]): number {
  if (!keyResults.length) return 0;
  return round1(keyResults.reduce((sum, kr) => sum + keyResultProgress(kr), 0) / keyResults.length);
}

// "2026-Q4" → first and last day ("2026-10-01", "2026-12-31").
export function quarterBounds(period: string): { start: string; end: string } {
  const year = Number(period.slice(0, 4));
  const q = Number(period.slice(-1));
  const startMonth = (q - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const nextQuarter = q === 4 ? `${year + 1}-01-01` : `${year}-${String(startMonth + 3).padStart(2, '0')}-01`;
  return { start, end: addDays(nextQuarter, -1) };
}

const days = (from: string, to: string) => Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / 86_400_000);

// Share (0–1) of the window [quarter start, deadline or quarter end] elapsed by `today`.
export function expectedFraction(period: string, deadline: string | null, today: string): number {
  const { start, end } = quarterBounds(period);
  const last = deadline && deadline >= start ? deadline : end;
  const total = days(start, last) + 1;
  return clamp((days(start, today) + 1) / total, 0, 1);
}

export function okrStatus(progress: number, period: string, deadline: string | null, today: string): OkrStatus {
  if (progress >= 100) return 'COMPLETED';
  const { start, end } = quarterBounds(period);
  const last = deadline && deadline >= start ? deadline : end;
  if (today > last) return 'OFF_TRACK';
  const expected = expectedFraction(period, deadline, today);
  if (today < start || expected < 0.1) return 'ON_TRACK';
  const ratio = progress / (expected * 100);
  if (ratio >= 0.7) return 'ON_TRACK';
  if (ratio >= 0.4) return 'AT_RISK';
  return 'OFF_TRACK';
}
