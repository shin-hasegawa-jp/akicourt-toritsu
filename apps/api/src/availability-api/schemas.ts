const str = { type: 'string' }
const nullable = { anyOf: [str, { type: 'null' }] }
const integer = { type: 'integer', minimum: 0 }
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const array = (items: object) => ({ type: 'array', items })
const state = { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] }
const surface = { type: 'string', enum: ['grass', 'hard'] }
const scope = { parkId: str, surface, weekStart: str }
export const jobSchema = object({
  ...scope,
  jobId: str,
  state,
  queuedAt: str,
  startedAt: nullable,
  completedAt: nullable,
  errorCode: nullable,
  requestCount: integer,
  retryAfter: integer,
})
export const updateSchema = object({
  dateFrom: str,
  dateTo: str,
  jobs: array({
    ...jobSchema,
    properties: { ...jobSchema.properties, reused: { type: 'boolean' } },
    required: [...jobSchema.required, 'reused'],
  }),
  pollAfterSeconds: integer,
})
export const searchSchema = object({
  generatedAt: str,
  dateFrom: str,
  dateTo: str,
  coverage: { type: 'string', enum: ['complete', 'partial', 'none'] },
  scopes: array(
    object({
      ...scope,
      dataState: { type: 'string', enum: ['fresh', 'stale', 'unavailable'] },
      snapshotId: nullable,
      lastSuccessAt: nullable,
      latestAttempt: {
        anyOf: [object({ jobId: str, state, errorCode: nullable }), { type: 'null' }],
      },
    }),
  ),
  slots: array(
    object({
      parkId: str,
      parkName: str,
      surface,
      facilityId: str,
      facilityName: str,
      date: str,
      start: str,
      end: str,
      availableCourts: { type: 'integer', minimum: 1 },
      snapshotId: str,
      observedAt: str,
    }),
  ),
  officialUrl: str,
})
export const errorSchema = object({ error: object({ code: str, message: str }) })
