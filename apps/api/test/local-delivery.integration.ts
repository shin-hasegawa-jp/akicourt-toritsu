import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore } from '@google-cloud/firestore'
import Fastify from 'fastify'
import { firestoreSettings } from '../src/storage/firestore/database'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { FirestoreAvailabilityService } from '../src/availability-api/firestore-service'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { OfficialSessionRepository } from '../src/storage/firestore/official-session'
import { AcquisitionWorker } from '../src/worker/runner'
import { createWorkerApp } from '../src/worker/app'
import { fixtureFetch } from './local-fixture-fetch'
import { deliverNext, localDispatcher } from '../src/local/delivery'

test(
  'local delivery runs one submitted job via real worker HTTP and publishes searchable fixtures',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 60000 },
  async () => {
    const projectId = 'demo-akicourt-local'
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    const worker = createWorkerApp(
      new AcquisitionWorker(
        new WorkerStore(db, projectId),
        new OfficialSessionRepository(db, projectId),
        { fetchImpl: fixtureFetch() },
      ),
    )
    const input = {
      targets: [{ parkId: '1280', surface: 'grass' as const }],
      dateFrom: '2026-10-19',
      dateTo: '2026-10-25',
    }
    const service = new FirestoreAvailabilityService(
      db,
      projectId,
      localDispatcher,
      () => new Date('2026-10-18T00:00:00Z'),
    )
    const signal = new AbortController().signal
    const failedWorker = Fastify()
    try {
      const refs = new ReferenceRepository(db)
      await refs.initialize(true)
      await refs.seed(true)
      await db.doc('control/acquisition').update({ updatesEnabled: true })
      const url = await worker.listen({ port: 0, host: '127.0.0.1' })
      const accepted = await service.updates(input)
      const jobId = accepted.body.jobs[0].jobId
      assert.equal(accepted.status, 202)
      assert.equal((await service.job(jobId)).state, 'queued')
      assert.equal(await deliverNext(db, url, signal), true)
      assert.equal((await service.job(jobId)).state, 'succeeded')
      assert.ok((await service.search(input)).slots.length > 0)
      assert.equal(await deliverNext(db, url, signal), false)
      // A delivery failure is surfaced to the loop, which stops instead of retrying.
      await service.updates({ ...input, targets: [{ parkId: '1040', surface: 'grass' }] })
      failedWorker.post('/tasks/acquire', async (_request, reply) => reply.code(503).send({}))
      const failedUrl = await failedWorker.listen({ port: 0, host: '127.0.0.1' })
      await assert.rejects(deliverNext(db, failedUrl, signal), /local-delivery-failed/)
    } finally {
      await worker.close()
      await failedWorker.close()
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await db.terminate()
    }
  },
)
