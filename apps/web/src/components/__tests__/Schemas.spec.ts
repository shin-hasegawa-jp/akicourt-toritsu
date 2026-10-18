import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  ConditionsSchema,
  JobSchema,
  SearchSchema,
  SlotSchema,
  UpdatesSchema,
} from '../../availability/schemas'
import { defaults } from '../../availability/model'

const timestamp = '2026-10-10T09:00:00.000Z'
const job = {
  parkId: '1280',
  surface: 'grass',
  jobId: 'test-job',
  weekStart: '2026-10-05',
  state: 'queued',
  requestCount: 0,
  retryAfter: 0,
  errorCode: null,
  queuedAt: timestamp,
  startedAt: null,
  completedAt: null,
}
const scope = {
  parkId: '1280',
  surface: 'grass',
  weekStart: '2026-10-05',
  dataState: 'unavailable',
  snapshotId: null,
  lastSuccessAt: null,
  latestAttempt: null,
}
const slot = {
  parkId: '1280',
  surface: 'grass',
  parkName: 'Test park',
  facilityId: 'test-facility',
  facilityName: 'Test court',
  date: '2026-10-10',
  start: '09:00',
  end: '11:00',
  availableCourts: 2,
  snapshotId: 'test-snapshot',
  observedAt: timestamp,
}
describe('Valibot API contracts', () => {
  it('accepts unavailable search and valid jobs while stripping extra response fields', () => {
    const search = {
      generatedAt: timestamp,
      dateFrom: '2026-10-10',
      dateTo: '2026-10-16',
      coverage: 'none',
      scopes: [scope],
      slots: [],
      officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
      extra: 'unused',
    }
    const parsed = v.safeParse(SearchSchema, search)
    expect(parsed.success).toBe(true)
    expect(parsed.output).not.toHaveProperty('extra')
    expect(v.safeParse(JobSchema, job).success).toBe(true)
    expect(v.safeParse(UpdatesSchema, { jobs: [job], pollAfterSeconds: 3 }).success).toBe(true)
  })
  it('rejects invalid counts, states, dates and polling bounds without coercion', () => {
    for (const extra of [
      { requestCount: '3' },
      { requestCount: -1 },
      { state: 'unknown' },
      { weekStart: '2026-02-30' },
      { startedAt: 'invalid' },
      { reused: 'true' },
    ])
      expect(v.safeParse(JobSchema, { ...job, ...extra }).success).toBe(false)
    for (const pollAfterSeconds of [0, 61, 1.5, '3'])
      expect(v.safeParse(UpdatesSchema, { jobs: [job], pollAfterSeconds }).success).toBe(false)
    expect(v.safeParse(UpdatesSchema, { jobs: [], pollAfterSeconds: 3 }).success).toBe(false)
    expect(
      v.safeParse(UpdatesSchema, { jobs: Array(11).fill(job), pollAfterSeconds: 3 }).success,
    ).toBe(false)
  })
  it('rejects invalid slot times, dates and court counts', () => {
    expect(v.safeParse(SlotSchema, slot).success).toBe(true)
    for (const extra of [
      { start: '29:00' },
      { end: '24:00' },
      { end: '09:00' },
      { date: '2026-02-30' },
      { availableCourts: 0 },
      { availableCourts: 1.5 },
    ])
      expect(v.safeParse(SlotSchema, { ...slot, ...extra }).success).toBe(false)
  })
  it('validates form range and holiday-only conditions', () => {
    const input = { ...defaults(), dateFrom: '2026-10-10', dateTo: '2026-10-16' }
    expect(v.safeParse(ConditionsSchema, input).success).toBe(true)
    const targets = ['1280:grass', '1310:hard', '1000:grass', '1040:grass', '1350:hard']
    expect(v.safeParse(ConditionsSchema, { ...input, targets }).success).toBe(true)
    expect(
      v.safeParse(ConditionsSchema, { ...input, targets: [...targets, '1370:hard'] }).success,
    ).toBe(false)
    expect(
      v.safeParse(ConditionsSchema, { ...input, weekdays: [], includeHolidays: true }).success,
    ).toBe(true)
    for (const extra of [
      { dateTo: '2026-10-17' },
      { targets: [] },
      { weekdays: [], includeHolidays: false },
      { timeFrom: '12:00', timeTo: '09:00' },
    ])
      expect(v.safeParse(ConditionsSchema, { ...input, ...extra }).success).toBe(false)
  })
})
