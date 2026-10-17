import { Result, Target } from '../src/availability/client'
import { offsetDate } from '../src/availability/parser'

export function syntheticResult(
  target: Target,
  count: number,
  date = target.startDate,
): Extract<Result, { state: 'success' }> {
  const clock = (m: number) =>
    `${Math.floor(m / 60)
      .toString()
      .padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`
  return {
    target,
    state: 'success',
    attemptedAt: '2026-10-17T00:00:00Z',
    completedAt: '2026-10-17T00:01:00Z',
    durationMs: 60000,
    requests: [],
    facilities: Array.from({ length: Math.max(1, Math.ceil(count / 100)) }, (_, f) => ({
      id: `facility_${f}`,
      name: `合成施設${f}`,
      week: {
        days: Array.from({ length: 7 }, (_, d) => offsetDate(target.startDate, d)),
        checkedCells: 700,
        slots: Array.from({ length: Math.min(100, Math.max(0, count - f * 100)) }, (_, s) => ({
          date,
          start: clock(540 + s),
          end: clock(541 + s),
          availableCourts: 1,
        })),
      },
    })),
  }
}
