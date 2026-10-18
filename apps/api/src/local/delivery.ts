import { setTimeout as delay } from 'node:timers/promises'
import { Firestore } from '@google-cloud/firestore'
import { Id, parseValue } from '../validation'
import { DispatchSchema } from '../storage/firestore/schemas'
import { connectFirestore } from '../storage/firestore/database'
import { localSettings } from './settings'
import { Dispatcher } from '../storage/firestore/task-dispatcher'

// Registration is the existing submitted marker. This emulator-only delivery
// loop consumes it separately, so the public API never waits for acquisition.
export const localDispatcher: Dispatcher = {
  submit: async () => {
    // dispatchPending writes the durable submitted marker after this acceptance.
  },
}

export async function deliverNext(db: Firestore, workerUrl: string, signal: AbortSignal) {
  const docs = await db
    .collection('jobs')
    .where('dispatchState', '==', 'submitted')
    .where('state', '==', 'queued')
    .limit(1)
    .get()
  const doc = docs.docs[0]
  if (!doc) return false
  const job = parseValue(DispatchSchema, doc.data(), () => new Error('invalid-local-job'))
  const jobId = parseValue(Id, doc.id, () => new Error('invalid-local-job'))
  const response = await fetch(`${workerUrl}/tasks/acquire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, generation: job.generation }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(850000)]),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error('local-delivery-failed')
  console.log(JSON.stringify({ event: 'local-task-delivered', jobId }))
  return true
}

async function start() {
  const settings = localSettings()
  const workerUrl = settings.workerUrl
  if (!workerUrl) throw new Error('local-worker-url-required')
  const db = connectFirestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '',
    databaseId: process.env.FIRESTORE_DATABASE_ID ?? '',
  })
  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    while (!shutdown.signal.aborted) {
      if (!(await deliverNext(db, workerUrl, shutdown.signal)))
        await delay(1000, undefined, { signal: shutdown.signal })
    }
  } catch (error) {
    if (!shutdown.signal.aborted) throw error
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await db.terminate()
  }
}
if (require.main === module) {
  void start().catch(() => {
    console.error(
      'Local delivery stopped. Check worker/storage, reset acquisition if needed, then restart delivery.',
    )
    process.exitCode = 1
  })
}
