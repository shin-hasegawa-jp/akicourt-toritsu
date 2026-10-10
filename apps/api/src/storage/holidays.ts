import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import calendar from './holiday-calendar'
import { transaction } from './database'
import { validateDate } from '../availability/parser'

export const HOLIDAY_SOURCE = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'
type Holiday = { date: string; name: string }
type Year = { year: number; count: number; sha256: string; holidays: Holiday[] }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => {
  throw new Error('invalid-holiday-calendar')
}

// The checksum detects accidental edits/truncation; official completeness is
// established by reviewing the CSV against the Cabinet Office annual tables.
export function validateCalendar(data: unknown, years: number[]): Year[] {
  if (
    !record(data) ||
    data.source !== HOLIDAY_SOURCE ||
    typeof data.verifiedAt !== 'string' ||
    !Array.isArray(data.years) ||
    !years.length ||
    new Set(years).size !== years.length ||
    years.some((year) => !Number.isInteger(year) || year < 1 || year > 9999)
  )
    return invalid()
  validateDate(data.verifiedAt)
  const available = new Map<number, Year>()
  for (const entry of data.years) {
    if (
      !record(entry) ||
      typeof entry.year !== 'number' ||
      !Number.isInteger(entry.year) ||
      entry.year < 1 ||
      entry.year > 9999 ||
      available.has(entry.year) ||
      !Array.isArray(entry.holidays) ||
      !entry.holidays.length ||
      entry.count !== entry.holidays.length ||
      typeof entry.sha256 !== 'string'
    )
      return invalid()
    const holidays: Holiday[] = []
    let previous = ''
    for (const row of entry.holidays) {
      if (
        !record(row) ||
        typeof row.date !== 'string' ||
        typeof row.name !== 'string' ||
        !row.name.trim() ||
        /[\t\r\n]/.test(row.name)
      )
        return invalid()
      validateDate(row.date)
      if (Number(row.date.slice(0, 4)) !== entry.year || row.date <= previous) return invalid()
      previous = row.date
      holidays.push({ date: row.date, name: row.name })
    }
    const hash = createHash('sha256')
      .update(holidays.map((row) => `${row.date}\t${row.name}`).join('\n'))
      .digest('hex')
    if (hash !== entry.sha256) return invalid()
    available.set(entry.year, { year: entry.year, count: holidays.length, sha256: hash, holidays })
  }
  return years
    .map((year) => {
      const entry = available.get(year)
      if (!entry) throw new Error('holiday-year-unavailable')
      return entry
    })
    .sort((a, b) => a.year - b.year)
}

export async function registerHolidays(
  pool: Pool,
  years: number[],
  data: unknown = calendar,
): Promise<void> {
  // Validate every requested year before touching the DB. Publish all years
  // atomically; interruption or insertion failure leaves existing data intact.
  const selected = validateCalendar(data, years)
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(1759104)')
    for (const entry of selected) {
      await client.query('DELETE FROM holidays WHERE extract(year FROM use_date)::integer=$1', [
        entry.year,
      ])
      for (const holiday of entry.holidays)
        await client.query(
          'INSERT INTO holidays(use_date,name,source,updated_at) VALUES($1,$2,$3,clock_timestamp())',
          [holiday.date, holiday.name, HOLIDAY_SOURCE],
        )
      await client.query(
        `INSERT INTO holiday_calendar_years(year,source) VALUES($1,$2)
        ON CONFLICT(year) DO UPDATE SET source=excluded.source,updated_at=clock_timestamp()`,
        [entry.year, HOLIDAY_SOURCE],
      )
    }
  })
}
