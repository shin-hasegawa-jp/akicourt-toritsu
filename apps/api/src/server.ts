import { localSettings } from './local/settings'
import { fixtureFetch } from './local/fixture-fetch'
import Fastify from 'fastify'
import * as v from 'valibot'
import api from './app'
import { parseValue } from './validation'
import { createWorkerApp, TaskRunner } from './worker/app'
import { AcquisitionWorker } from './worker/runner'
import { connectFirestore } from './storage/firestore/database'
import { WorkerStore } from './storage/firestore/worker-store'
import { OfficialSessionRepository } from './storage/firestore/official-session'

const Settings = v.object({
  role: v.picklist(['api', 'worker']),
  port: v.pipe(
    v.string(),
    v.regex(/^\d+$/),
    v.transform(Number),
    v.integer(),
    v.minValue(1),
    v.maxValue(65535),
  ),
  host: v.picklist(['127.0.0.1', '0.0.0.0']),
})
export function serverSettings(environment: NodeJS.ProcessEnv = process.env) {
  const production = environment.NODE_ENV === 'production'
  return parseValue(
    Settings,
    {
      role: environment.APP_ROLE ?? (production ? undefined : 'api'),
      port: environment.PORT ?? (production ? '8080' : '17591'),
      host: production ? '0.0.0.0' : (environment.API_HOST ?? '127.0.0.1'),
    },
    () => new Error('invalid-server-settings'),
  )
}

// Select a single route tree. Cloud Run IAM authenticates worker callers;
// task headers and a private-looking URL do not provide authentication.
export function createRuntimeApp(role: 'api' | 'worker', worker?: TaskRunner) {
  if (role === 'api') {
    const app = Fastify({ logger: true })
    void app.register(api)
    return app
  }
  if (worker) return createWorkerApp(worker)
  const local = process.env.NODE_ENV !== 'production' ? localSettings() : undefined
  if (!local && process.env.LOCAL_ACQUISITION !== undefined)
    throw new Error('local-runtime-forbidden')
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? ''
  const db = connectFirestore({ projectId, databaseId: process.env.FIRESTORE_DATABASE_ID ?? '' })
  const app = createWorkerApp(
    new AcquisitionWorker(
      new WorkerStore(db, projectId),
      new OfficialSessionRepository(db, projectId),
      local?.mode === 'fixture' ? { fetchImpl: fixtureFetch() } : {},
    ),
  )
  app.addHook('onClose', () => db.terminate())
  return app
}

async function start() {
  const settings = serverSettings()
  const app = createRuntimeApp(settings.role)
  if (settings.role === 'api') {
    const stop = () => {
      void app.close().catch(() => {
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    app.addHook('onClose', async () => {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
    })
  }
  try {
    await app.listen({ port: settings.port, host: settings.host })
  } catch (error) {
    await app.close()
    throw error
  }
}
if (require.main === module) {
  void start().catch(() => {
    console.error('Application startup failed. Check APP_ROLE, PORT and service configuration.')
    process.exitCode = 1
  })
}
