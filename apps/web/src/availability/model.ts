import * as v from 'valibot'
import { ConditionsSchema, type Conditions } from './schemas'
export { parks, parkGroups } from './parks'
export type { Conditions, Scope, Slot, SearchResult } from './schemas'
export const weekdayNames = ['日', '月', '火', '水', '木', '金', '土']
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
export function offset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function defaults(): Conditions {
  const dateFrom = today()
  return {
    targets: ['1280:grass'],
    dateFrom,
    dateTo: offset(dateFrom, 6),
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    includeHolidays: false,
    timeFrom: '00:00',
    timeTo: '24:00',
    minDurationMinutes: 0,
  }
}
export function validate(input: Conditions): string | null {
  const parsed = v.safeParse(ConditionsSchema, input)
  return parsed.success ? null : parsed.issues[0].message
}
