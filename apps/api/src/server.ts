import { AvailabilityService } from './routes/availability'
import { FirestoreAvailabilityService } from './availability-api/firestore-service'
import { CloudTaskDispatcher } from './storage/firestore/task-dispatcher'
import { localDispatcher } from './local/delivery'
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

type RuntimeDependencies = (
  { role: 'api'; service?: AvailabilityService } | { role: 'worker'; worker: TaskRunner }
) & { close?: () => Promise<void> }

// Route trees only consume dependencies; no environment or SDK construction here.
export function createRuntimeApp(dependencies: RuntimeDependencies) {
  const app =
    dependencies.role === 'api'
      ? Fastify({ logger: true }).register(api, { service: dependencies.service })
      : createWorkerApp(dependencies.worker)
  if (dependencies.close) app.addHook('onClose', dependencies.close)
  return app
}

// Composition root: choose transports once and own their lifecycle.
export function buildRuntimeApp(role: 'api' | 'worker') {
  const local = process.env.LOCAL_ACQUISITION !== undefined ? localSettings() : undefined
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? ''
  if (role === 'api' && !projectId) return createRuntimeApp({ role })
  if (role === 'worker' && process.env.NODE_ENV !== 'production' && !local)
    throw new Error('local-worker-not-configured')
  const fetchImpl = local?.mode === 'fixture' && role === 'worker' ? fixtureFetch() : fetch
  const cloudTasks =
    role === 'api' && process.env.NODE_ENV === 'production'
      ? new CloudTaskDispatcher({
          projectId: projectId ?? '',
          location: process.env.TASKS_LOCATION ?? '',
          queue: process.env.TASKS_QUEUE ?? '',
          callerSA: process.env.TASKS_CALLER_SA ?? '',
          workerUrl: process.env.WORKER_URL ?? '',
        })
      : undefined
  const db = connectFirestore({
    projectId: projectId ?? '',
    databaseId: process.env.FIRESTORE_DATABASE_ID ?? '',
  })
  const close = async () => {
    try {
      await cloudTasks?.close()
    } finally {
      await db.terminate()
    }
  }
  return role === 'api'
    ? createRuntimeApp({
        role,
        service: new FirestoreAvailabilityService(
          db,
          projectId,
          cloudTasks ?? (local ? localDispatcher : undefined),
        ),
        close,
      })
    : createRuntimeApp({
        role,
        worker: new AcquisitionWorker(
          new WorkerStore(db, projectId),
          new OfficialSessionRepository(db, projectId),
          { fetchImpl },
        ),
        close,
      })
}

async function start() {
  const settings = serverSettings()
  const app = buildRuntimeApp(settings.role)
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
