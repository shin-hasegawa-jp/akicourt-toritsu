import * as v from 'valibot'
import { parks } from './parks'

const date = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/),
  v.check((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }),
)
const instant = v.pipe(
  v.string(),
  v.check((value) => !Number.isNaN(Date.parse(value))),
)
const time = v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
const endTime = v.union([time, v.literal('24:00')])
const surface = v.picklist(['grass', 'hard'])
const state = v.picklist(['queued', 'running', 'succeeded', 'failed'])
const nonnegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0))
const target = { parkId: v.string(), surface }

export const ScopeSchema = v.object({
  ...target,
  weekStart: date,
  dataState: v.picklist(['fresh', 'stale', 'unavailable']),
  snapshotId: v.nullable(v.string()),
  lastSuccessAt: v.nullable(instant),
  latestAttempt: v.nullable(
    v.object({
      jobId: v.string(),
      state,
      errorCode: v.nullable(v.string()),
    }),
  ),
})
export const SlotSchema = v.pipe(
  v.object({
    ...target,
    parkName: v.string(),
    facilityId: v.string(),
    facilityName: v.string(),
    date,
    start: time,
    end: time,
    availableCourts: v.pipe(v.number(), v.integer(), v.minValue(1)),
    snapshotId: v.string(),
    observedAt: instant,
  }),
  v.check((slot) => slot.start < slot.end),
)
export const SearchSchema = v.object({
  generatedAt: instant,
  dateFrom: date,
  dateTo: date,
  coverage: v.picklist(['complete', 'partial', 'none']),
  scopes: v.pipe(v.array(ScopeSchema), v.minLength(1), v.maxLength(4)),
  slots: v.pipe(v.array(SlotSchema), v.maxLength(10000)),
  officialUrl: v.literal('https://kouen.sports.metro.tokyo.lg.jp/web/'),
})
export const JobSchema = v.object({
  ...target,
  jobId: v.string(),
  weekStart: date,
  state,
  requestCount: nonnegativeInteger,
  retryAfter: nonnegativeInteger,
  errorCode: v.nullable(v.string()),
  queuedAt: instant,
  startedAt: v.nullable(instant),
  completedAt: v.nullable(instant),
  reused: v.optional(v.boolean()),
})
export const UpdatesSchema = v.object({
  jobs: v.pipe(v.array(JobSchema), v.minLength(1), v.maxLength(4)),
  pollAfterSeconds: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(60)),
})
export const ErrorSchema = v.object({ error: v.object({ code: v.string(), message: v.string() }) })

const targetMessage = '公園・種目を1〜2件選んでください。'
const dateMessage = '開始日と終了日を含め、最大7日間の期間を指定してください。'
export const ConditionFieldsSchema = v.object({
  targets: v.pipe(
    v.array(
      v.picklist(
        parks.map((park) => park.key),
        targetMessage,
      ),
      targetMessage,
    ),
    v.minLength(1, targetMessage),
    v.maxLength(2, targetMessage),
    v.check((keys) => new Set(keys).size === keys.length, targetMessage),
  ),
  dateFrom: v.pipe(
    v.string(),
    v.check((value) => v.safeParse(date, value).success, dateMessage),
  ),
  dateTo: v.pipe(
    v.string(),
    v.check((value) => v.safeParse(date, value).success, dateMessage),
  ),
  weekdays: v.pipe(
    v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
    v.maxLength(7),
    v.check((days) => new Set(days).size === days.length),
  ),
  includeHolidays: v.boolean(),
  startTimes: v.optional(
    v.pipe(
      v.array(time),
      v.maxLength(24),
      v.check((values) => new Set(values).size === values.length),
    ),
    [],
  ),
  timeFrom: time,
  timeTo: endTime,
  minDurationMinutes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440)),
})
export const ConditionsSchema = v.pipe(
  ConditionFieldsSchema,
  v.check(
    (input) =>
      input.dateFrom <= input.dateTo &&
      Date.parse(input.dateTo) - Date.parse(input.dateFrom) <= 6 * 86400000,
    dateMessage,
  ),
  v.check(
    (input) => input.weekdays.length > 0 || input.includeHolidays,
    '曜日を選ぶか、祝日を含めてください。',
  ),
  v.check((input) => input.timeFrom < input.timeTo, '終了時刻は開始時刻より後にしてください。'),
)
export type Conditions = v.InferOutput<typeof ConditionsSchema>
export type Scope = v.InferOutput<typeof ScopeSchema>
export type Slot = v.InferOutput<typeof SlotSchema>
export type SearchResult = v.InferOutput<typeof SearchSchema>
export type Job = v.InferOutput<typeof JobSchema>
