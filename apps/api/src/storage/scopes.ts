import { Target } from '../availability/client'
import { offsetDate, validateDate } from '../availability/parser'

export function japanToday(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
export function scopes(
  targets: Omit<Target, 'startDate'>[],
  from = japanToday(),
  to = offsetDate(from, 6),
): Target[] {
  validateDate(from)
  validateDate(to)
  if (from > to || to > offsetDate(from, 6) || !targets.length || targets.length > 5)
    throw new Error('Invalid range or targets')
  if (new Set(targets.map((t) => `${t.parkId}/${t.surface}`)).size !== targets.length)
    throw new Error('Duplicate target')
  const monday = (date: string): string =>
    offsetDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7))
  const weeks = [...new Set([monday(from), monday(to)])]
  return targets.flatMap((target) => weeks.map((startDate) => ({ ...target, startDate })))
}
