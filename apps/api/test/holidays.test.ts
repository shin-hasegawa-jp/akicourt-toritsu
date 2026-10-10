import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import calendar from '../src/storage/holiday-calendar'
import { HOLIDAY_SOURCE, registerHolidays, validateCalendar } from '../src/storage/holidays'
import { migrate } from '../src/storage/database'
import { Store } from '../src/storage/store'
import { scopes } from '../src/storage/scopes'
import { offsetDate } from '../src/availability/parser'
import { AvailabilityService } from '../src/availability-api/service'
import { Input } from '../src/availability-api/input'

void test('verified annual calendars include substitute and national holidays', () => {
  const years = validateCalendar(calendar, [2026, 2027])
  assert.deepEqual(
    years.map((entry) => entry.count),
    [18, 17],
  )
  assert.ok(years[0].holidays.some((row) => row.date === '2026-05-06' && row.name === '休日'))
  assert.ok(years[0].holidays.some((row) => row.date === '2026-09-22' && row.name === '休日'))
  assert.ok(years[1].holidays.some((row) => row.date === '2027-03-22' && row.name === '休日'))
})

void test('reject incomplete, corrupted, duplicate, invalid and unavailable annual data', () => {
  const mutate = (change: (data: typeof calendar) => void) => {
    const data = structuredClone(calendar)
    change(data)
    assert.throws(() => validateCalendar(data, [2026, 2027]))
  }
  mutate((data) => {
    data.years[0].holidays.pop()
  })
  mutate((data) => {
    data.years[0].holidays.pop()
    data.years[0].count--
  })
  mutate((data) => {
    data.years[0].holidays[0].name = 'changed'
  })
  mutate((data) => {
    data.years[0].holidays[1].date = '2026-01-01'
  })
  mutate((data) => {
    data.years[0].holidays[0].date = '2026-02-30'
  })
  mutate((data) => {
    data.years[0].holidays[0].date = '2025-01-01'
  })
  mutate((data) => {
    data.years.push(data.years[0])
  })
  mutate((data) => {
    data.source = 'unverified'
  })
  for (const years of [[], [2026, 2026], [2026, 2028], [NaN]])
    assert.throws(() => validateCalendar(calendar, years))
})

void test(
  'holiday publication is atomic and repeatable; holiday/OR/year-crossing search uses real DB',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    const service = new AvailabilityService(pool)
    const store = new Store(pool)
    const owner = randomUUID()
    const target = { parkId: '1280', surface: 'grass' as const }
    const input = {
      targets: [target],
      dateFrom: '2026-09-19',
      dateTo: '2026-09-25',
      weekdays: [] as number[],
      includeHolidays: true,
    }
    const publish = async (from: string, to: string) => {
      const targets = scopes([target], from, to)
      await store.enqueue(targets)
      for (const _target of targets) {
        const job = (await store.claim(owner))!
        const days = Array.from({ length: 7 }, (_, i) => offsetDate(job.week_start, i))
        await store.finish(owner, job, {
          target: { ...target, startDate: job.week_start },
          state: 'success',
          attemptedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 1,
          requests: [],
          facilities: [
            {
              id: '12800020',
              name: 'Synthetic court',
              week: {
                days,
                checkedCells: 7,
                slots: days.map((date) => ({
                  date,
                  start: '09:00',
                  end: '11:00',
                  availableCourts: 1,
                })),
              },
            },
          ],
        })
      }
    }
    const dates = async (query: Input = input) =>
      (await service.search(query)).slots.map((row) => row.date)
    try {
      await migrate(pool)
      await assert.rejects(service.search(input), /対象年の祝日情報/)
      await registerHolidays(pool, [2026])
      const originalMarker = (
        await pool.query('SELECT updated_at FROM holiday_calendar_years WHERE year=2026')
      ).rows[0].updated_at
      await assert.rejects(registerHolidays(pool, [2026, 2028]))
      assert.equal((await pool.query('SELECT count(*) FROM holidays')).rows[0].count, '18')
      // Simulate interruption/insertion failure after the first year is replaced.
      await pool.query(`CREATE FUNCTION reject_holiday() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.use_date='2027-01-01'::date THEN RAISE EXCEPTION 'simulated import failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_holiday BEFORE INSERT ON holidays FOR EACH ROW EXECUTE FUNCTION reject_holiday()`)
      await assert.rejects(registerHolidays(pool, [2026, 2027]), /simulated import failure/)
      assert.deepEqual(
        (await pool.query('SELECT updated_at FROM holiday_calendar_years WHERE year=2026')).rows[0]
          .updated_at,
        originalMarker,
      )
      assert.equal((await pool.query('SELECT count(*) FROM holidays')).rows[0].count, '18')
      assert.deepEqual((await pool.query('SELECT year FROM holiday_calendar_years')).rows, [
        { year: 2026 },
      ])
      await pool.query('DROP TRIGGER reject_holiday ON holidays; DROP FUNCTION reject_holiday()')
      // A re-import also removes obsolete rows in the selected year.
      await pool.query(
        "INSERT INTO holidays(use_date,name,source,updated_at) VALUES('2026-01-02','obsolete','test',clock_timestamp())",
      )
      await Promise.all([
        registerHolidays(pool, [2026, 2027]),
        registerHolidays(pool, [2026, 2027]),
      ])
      assert.equal((await pool.query('SELECT count(*) FROM holidays')).rows[0].count, '35')
      assert.deepEqual(
        (await pool.query('SELECT year,source FROM holiday_calendar_years ORDER BY year')).rows,
        [
          { year: 2026, source: HOLIDAY_SOURCE },
          { year: 2027, source: HOLIDAY_SOURCE },
        ],
      )
      await store.takeLease(owner)
      await publish(input.dateFrom, input.dateTo)
      assert.deepEqual(await dates(), ['2026-09-21', '2026-09-22', '2026-09-23'])
      assert.deepEqual(await dates({ ...input, weekdays: [0, 6] }), [
        '2026-09-19',
        '2026-09-20',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
      ])
      const crossing = { ...input, dateFrom: '2026-12-29', dateTo: '2027-01-04' }
      await publish(crossing.dateFrom, crossing.dateTo)
      assert.deepEqual(await dates(crossing), ['2027-01-01'])
      await pool.query('DELETE FROM holiday_calendar_years WHERE year=2027')
      await assert.rejects(service.search(crossing), /対象年の祝日情報/)
      assert.deepEqual(await dates(), ['2026-09-21', '2026-09-22', '2026-09-23'])
      await store.release(owner)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)
