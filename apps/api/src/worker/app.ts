import Fastify, { FastifyError } from 'fastify'
import * as v from 'valibot'
import { Id, NonNegativeInteger } from '../validation'
import { DispatchJob } from '../storage/firestore/jobs'

const Task = v.strictObject({ jobId: Id, generation: NonNegativeInteger })
type Runner = { run(task: DispatchJob, signal: AbortSignal): Promise<void> }

// Separate from public route autoload. Deploy only behind Cloud Run IAM;
// Cloud Tasks headers are not authentication. Role selection is wired in FS-3.
export function createWorkerApp(worker: Runner) {
  const app = Fastify({ bodyLimit: 1024 })
  const shutdown = new AbortController()
  const stop = () => {
    shutdown.abort()
    void app.close().catch(() => {})
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  app.addHook('preClose', async () => {
    shutdown.abort()
  })
  app.addHook('onClose', async () => {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  })
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const invalid =
      error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
    reply.code(invalid ? 400 : 503).send({ error: invalid ? 'invalid_task' : 'worker_unavailable' })
  })
  app.get('/health', async () => ({ ok: true }))
  app.post('/tasks/acquire', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = v.safeParse(Task, request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_task' })
    const disconnected = new AbortController()
    const abort = () => {
      disconnected.abort()
    }
    const close = () => {
      if (!reply.raw.writableFinished) abort()
    }
    request.raw.once('aborted', abort)
    reply.raw.once('close', close)
    try {
      await worker.run(parsed.output, AbortSignal.any([shutdown.signal, disconnected.signal]))
      return { ok: true }
    } catch {
      return reply.code(503).header('Retry-After', '30').send({ error: 'worker_unavailable' })
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', close)
    }
  })
  return app
}
