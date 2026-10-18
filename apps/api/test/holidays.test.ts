import { test } from 'node:test'
import assert from 'node:assert/strict'
import calendar from '../src/storage/holiday-calendar'
import { validateCalendar } from '../src/storage/holidays'

test('verified annual calendars include substitute and national holidays', () => {
  const years = validateCalendar(calendar, [2026, 2027])
  assert.deepEqual(
    years.map((entry) => entry.count),
    [18, 17],
  )
  assert.ok(years[0].holidays.some((row) => row.date === '2026-05-06' && row.name === '休日'))
  assert.ok(years[0].holidays.some((row) => row.date === '2026-09-22' && row.name === '休日'))
  assert.ok(years[1].holidays.some((row) => row.date === '2027-03-22' && row.name === '休日'))
})

test('reject incomplete, corrupted, duplicate, invalid and unavailable annual data', () => {
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
