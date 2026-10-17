import * as v from 'valibot'
import { DateString, parseValue } from '../validation'
import { createHash } from 'node:crypto'
import { Pool, PoolClient } from 'pg'
import calendar from './holiday-calendar'
import { transaction } from './database'

export const HOLIDAY_SOURCE = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'
type Holiday = { date: string; name: string }
type Year = { year: number; count: number; sha256: string; holidays: Holiday[] }
export const yearSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9999))
export const CalendarSchema = v.object({
  source: v.literal(HOLIDAY_SOURCE),
  verifiedAt: DateString,
  years: v.array(
    v.object({
      year: yearSchema,
      count: v.number(),
      sha256: v.string(),
      holidays: v.pipe(
        v.array(
          v.object({
            date: DateString,
            name: v.pipe(
              v.string(),
              v.check((s) => !!s.trim() && !/[\t\r\n]/.test(s)),
            ),
          }),
        ),
        v.minLength(1),
      ),
    }),
  ),
})
const invalid = (): never => {
  throw new Error('invalid-holiday-calendar')
}

// The checksum detects accidental edits/truncation; official completeness is
// established by reviewing the CSV against the Cabinet Office annual tables.
export function validateCalendar(input: unknown, years: number[]): Year[] {
  const data = parseValue(CalendarSchema, input, () => new Error('invalid-holiday-calendar'))
  parseValue(
    v.pipe(
      v.array(yearSchema),
      v.minLength(1),
      v.check((ys) => new Set(ys).size === ys.length),
    ),
    years,
    () => new Error('invalid-holiday-calendar'),
  )
  const available = new Map<number, Year>()
  for (const entry of data.years) {
    if (available.has(entry.year) || entry.count !== entry.holidays.length) return invalid()
    const holidays: Holiday[] = []
    let previous = ''
    for (const row of entry.holidays) {
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
    await writeHolidays(client, selected)
  })
}

export async function writeHolidays(client: PoolClient, selected: Year[]): Promise<void> {
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
}
