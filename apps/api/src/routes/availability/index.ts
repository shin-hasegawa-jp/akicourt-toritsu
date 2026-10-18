import {
  RequestLimits,
  RequestKind,
  requestTimeoutMs,
  withTimeout,
} from '../../availability-api/controls'
import * as v from 'valibot'
import { parseValue } from '../../validation'
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { connectFirestore } from '../../storage/firestore/database'
import { AdmissionError } from '../../storage/firestore/jobs'
import { CloudTaskDispatcher } from '../../storage/firestore/task-dispatcher'
import { FirestoreAvailabilityService } from '../../availability-api/firestore-service'
import {
  ApiError,
  Input,
  InputSchema,
  bodySchema,
  commonProperties,
  searchProperties,
  resolveInput,
} from '../../availability-api/input'
import { errorSchema, jobSchema, searchSchema, updateSchema } from '../../availability-api/schemas'

// Inject dependencies for isolated tests. Normal startup owns and closes its SDK clients.
const routes: FastifyPluginAsync<{
  service?: Pick<FirestoreAvailabilityService, 'parks' | 'search' | 'updates' | 'job'>
}> = async (app, opts) => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
  const db =
    !opts.service && projectId
      ? connectFirestore({
          projectId,
          databaseId: process.env.FIRESTORE_DATABASE_ID ?? '',
        })
      : undefined
  if (db) app.addHook('onClose', () => db.terminate())
  const cloudTasks =
    db && process.env.NODE_ENV === 'production'
      ? new CloudTaskDispatcher({
          projectId: projectId ?? '',
          location: process.env.TASKS_LOCATION ?? '',
          queue: process.env.TASKS_QUEUE ?? '',
          callerSA: process.env.TASKS_CALLER_SA ?? '',
          workerUrl: process.env.WORKER_URL ?? '',
        })
      : undefined
  if (cloudTasks) app.addHook('onClose', () => cloudTasks.close())
  const backend =
    opts.service ?? (db ? new FirestoreAvailabilityService(db, projectId!, cloudTasks) : undefined)
  const service = () => {
    if (!backend) throw new ApiError(503, 'storage_unavailable', '保存先へ接続できません。')
    return backend
  }
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { validation?: unknown; statusCode?: number; message?: string }
    let known = error instanceof ApiError ? error : undefined
    if (failure.validation || failure.statusCode === 400)
      known = new ApiError(400, 'invalid_request', '入力内容を確認してください。')
    const safe = known ?? new ApiError(503, 'storage_unavailable', '保存先を利用できません。')
    if (error instanceof AdmissionError) reply.header('Retry-After', String(error.retryAfter))
    reply.code(safe.status).send({ error: { code: safe.code, message: safe.message } })
  })
  const limits = new RequestLimits()
  const limit = (kind: RequestKind) => async (_request: FastifyRequest, reply: FastifyReply) => {
    const retry = limits.retryAfter(kind)
    if (retry)
      return reply
        .code(429)
        .header('Retry-After', String(retry))
        .send({
          error: {
            code: 'rate_limited',
            message: '受付上限に達しています。時間をおいて再試行してください。',
          },
        })
  }
  const errors = { 400: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema }
  app.get('/parks', { onRequest: limit('parks') }, async () =>
    withTimeout(() => service().parks(), requestTimeoutMs),
  )

  // Validate before AJV can coerce values or strip unknown fields.
  const validateBody = (schema: v.GenericSchema) => async (request: { body: unknown }) => {
    request.body = parseValue(
      schema,
      request.body,
      () => new ApiError(400, 'invalid_request', '入力内容を確認してください。'),
    )
  }
  app.post<{ Body: Input }>(
    '/search',
    {
      onRequest: limit('search'),
      preValidation: validateBody(InputSchema),
      schema: { body: bodySchema(searchProperties), response: { 200: searchSchema, ...errors } },
    },
    async (request) => {
      const query = resolveInput(request.body)
      return withTimeout(() => service().search(request.body, query), requestTimeoutMs)
    },
  )
  app.post<{ Body: Input }>(
    '/updates',
    {
      onRequest: limit('updates'),
      preValidation: validateBody(v.pick(InputSchema, ['targets', 'dateFrom', 'dateTo'])),
      schema: {
        body: bodySchema(commonProperties),
        response: { 200: updateSchema, 202: updateSchema, ...errors },
      },
    },
    async (request, reply) => {
      const query = resolveInput(request.body, true)
      const result = await withTimeout(
        () => service().updates(request.body, query),
        requestTimeoutMs,
      )
      return reply.code(result.status).send(result.body)
    },
  )
  app.get<{ Params: { jobId: string } }>(
    '/updates/:jobId',
    {
      onRequest: limit('job'),
      schema: {
        params: {
          type: 'object',
          required: ['jobId'],
          properties: { jobId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: jobSchema, ...errors },
      },
    },
    async (request) => withTimeout(() => service().job(request.params.jobId), requestTimeoutMs),
  )
}
export default routes
