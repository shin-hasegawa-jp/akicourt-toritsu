import { Target } from '../availability/client'
import { offsetDate, validateDate } from '../availability/parser'
import { japanToday, scopes } from '../storage/scopes'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export type Input = {
  targets: Omit<Target, 'startDate'>[]
  dateFrom?: string
  dateTo?: string
  weekdays?: number[]
  includeHolidays?: boolean
  timeFrom?: string
  timeTo?: string
  minDurationMinutes?: number
}
export function resolveInput(input: Input, update = false) {
  try {
    if ((input.dateFrom === undefined) !== (input.dateTo === undefined)) throw new Error()
    const today = japanToday()
    const dateFrom = input.dateFrom ?? today
    const dateTo = input.dateTo ?? offsetDate(dateFrom, 6)
    validateDate(dateFrom)
    validateDate(dateTo)
    if (dateFrom.startsWith('0000') || dateTo.startsWith('0000')) throw new Error()
    if (update && dateFrom < today) throw new Error()
    const targets = scopes(input.targets, dateFrom, dateTo)
    const weekdays = input.weekdays ?? [0, 1, 2, 3, 4, 5, 6]
    const includeHolidays = input.includeHolidays ?? false
    if (!weekdays.length && !includeHolidays) throw new Error()
    const minute = (time: string) => {
      const [h, m] = time.split(':').map(Number)
      return h * 60 + m
    }
    const timeFrom = minute(input.timeFrom ?? '00:00')
    const timeTo = minute(input.timeTo ?? '24:00')
    if (timeFrom >= timeTo) throw new Error()
    return {
      dateFrom,
      dateTo,
      targets,
      weekdays,
      includeHolidays,
      timeFrom,
      timeTo,
      minDurationMinutes: input.minDurationMinutes ?? 0,
    }
  } catch {
    throw new ApiError(
      400,
      'invalid_request',
      '対象・期間・曜日・時間帯の指定を確認してください。期間は7日以内です。',
    )
  }
}
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const time = { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }
export const commonProperties = {
  targets: {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['parkId', 'surface'],
      properties: {
        parkId: { type: 'string', pattern: '^\\d{4}$' },
        surface: { type: 'string', enum: ['grass', 'hard'] },
      },
    },
  },
  dateFrom: date,
  dateTo: date,
}
export const searchProperties = {
  ...commonProperties,
  weekdays: {
    type: 'array',
    maxItems: 7,
    uniqueItems: true,
    items: { type: 'integer', minimum: 0, maximum: 6 },
  },
  includeHolidays: { type: 'boolean' },
  timeFrom: time,
  timeTo: { type: 'string', pattern: '^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$' },
  minDurationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
}
export const bodySchema = (properties: object) => ({
  type: 'object',
  additionalProperties: false,
  required: ['targets'],
  properties,
})
