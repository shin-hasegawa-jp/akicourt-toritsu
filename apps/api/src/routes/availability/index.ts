import { FastifyPluginAsync } from 'fastify'
import { Pool } from 'pg'
import parks from '../../storage/park-options'
import { database } from '../../storage/database'
import { AvailabilityService } from '../../availability-api/service'
import {
  ApiError,
  Input,
  bodySchema,
  commonProperties,
  searchProperties,
  resolveInput,
} from '../../availability-api/input'
import { errorSchema, jobSchema, searchSchema, updateSchema } from '../../availability-api/schemas'

// pool injection is used only by integration tests; normal startup owns its pool.
const routes: FastifyPluginAsync<{ pool?: Pool }> = async (app, opts) => {
  const pool = opts.pool ?? (process.env.DATABASE_URL ? database() : undefined)
  if (pool && !opts.pool) {
    const onError = () => app.log.error('availability database unavailable')
    pool.on('error', onError)
    app.addHook('onClose', async () => {
      pool.removeListener('error', onError)
      await pool.end()
    })
  }
  const service = () => {
    if (!pool) throw new ApiError(503, 'storage_unavailable', '保存先へ接続できません。')
    return new AvailabilityService(pool)
  }
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { validation?: unknown; statusCode?: number; message?: string }
    let known = error instanceof ApiError ? error : undefined
    if (failure.validation || failure.statusCode === 400)
      known = new ApiError(400, 'invalid_request', '入力内容を確認してください。')
    if (failure.message === 'unsupported-target')
      known = new ApiError(400, 'invalid_request', '未対応の公園・種目です。')
    if (['worker-blocked', 'worker-unavailable'].includes(failure.message || ''))
      known = new ApiError(503, 'worker_unavailable', '取得ワーカーが停止しています。')
    const safe = known ?? new ApiError(503, 'storage_unavailable', '保存先を利用できません。')
    reply.code(safe.status).send({ error: { code: safe.code, message: safe.message } })
  })
  const errors = { 400: errorSchema, 404: errorSchema, 503: errorSchema }
  app.get('/parks', async () => ({
    defaultTarget: parks.some((park) => park.parkId === '1280' && park.surface === 'grass')
      ? '1280:grass'
      : `${parks[0].parkId}:${parks[0].surface}`,
    groups: (['hard', 'grass'] as const).map((surface) => ({
      surface,
      label: surface === 'hard' ? 'ハード' : '人工芝',
      parks: parks
        .filter((park) => park.surface === surface)
        .map((park) => ({
          parkId: park.parkId,
          parkName: park.name,
        })),
    })),
  }))

  // Fastify's default AJV removes additional fields. Reject them before validation
  // so a misspelled date/filter cannot silently broaden a search or update.
  const rejectUnknown = (properties: object) => async (request: { body: unknown }) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return
    if (Object.keys(body).some((key) => !(key in properties)))
      throw new ApiError(400, 'invalid_request', '未対応の入力項目があります。')
    const targets = (body as Input).targets
    if (
      Array.isArray(targets) &&
      targets.some(
        (t) =>
          t &&
          typeof t === 'object' &&
          Object.keys(t).some((k) => !['parkId', 'surface'].includes(k)),
      )
    )
      throw new ApiError(400, 'invalid_request', '未対応の対象項目があります。')
  }
  app.post<{ Body: Input }>(
    '/search',
    {
      preValidation: rejectUnknown(searchProperties),
      schema: { body: bodySchema(searchProperties), response: { 200: searchSchema, ...errors } },
    },
    async (request) => {
      const query = resolveInput(request.body)
      return service().search(request.body, query)
    },
  )
  app.post<{ Body: Input }>(
    '/updates',
    {
      preValidation: rejectUnknown(commonProperties),
      schema: {
        body: bodySchema(commonProperties),
        response: { 200: updateSchema, 202: updateSchema, ...errors },
      },
    },
    async (request, reply) => {
      const query = resolveInput(request.body, true)
      const result = await service().updates(request.body, query)
      return reply.code(result.status).send(result.body)
    },
  )
  app.get<{ Params: { jobId: string } }>(
    '/updates/:jobId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['jobId'],
          properties: { jobId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: jobSchema, ...errors },
      },
    },
    async (request) => service().job(request.params.jobId),
  )
}
export default routes
