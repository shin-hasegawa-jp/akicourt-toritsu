import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Firestore } from '@google-cloud/firestore'
import { Target } from '../src/availability/client'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import { JobRepository } from '../src/storage/firestore/jobs'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { OfficialSessionRepository } from '../src/storage/firestore/official-session'
import { scopeId } from '../src/storage/firestore/snapshot-codec'
import { AcquisitionWorker } from '../src/worker/runner'
import { createWorkerApp } from '../src/worker/app'

const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-12' }
const facility =
  '<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="1280"><select id="facility-select"><option value="12800020_3">Tennis</option></select>'
const weekly = JSON.stringify(
  JSON.parse(readFileSync(join(__dirname, 'availability/fixtures/grass-11.json'), 'utf8')),
)
  .replace(/202610(1[0-6])/g, (day) => String(Number(day) + 2))
  .replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

test(
  'HTTP worker with Firestore and fake official HTTP',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 120000 },
  async (t) => {
    const projectId = 'demo-akicourt-local'
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date()
    const jobs = new JobRepository(db, () => now)
    const sessions = new OfficialSessionRepository(db, projectId, () => now)
    const control = db.doc('control/acquisition'),
      session = db.doc('officialSessions/current'),
      scope = db.doc(`scopes/${scopeId(target)}`)
    const paths: string[] = []
    const times: number[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname
      paths.push(path)
      times.push(now.getTime())
      assert.equal((await session.get()).get('inFlight.phase'), 'sent')
      if (path.includes('Ajax'))
        assert.match(new Headers(init?.headers).get('cookie') ?? '', /SESSION=private/)
      return path === '/web/'
        ? new Response('pawab2000', {
            headers: { 'set-cookie': 'SESSION=private; Path=/; Secure' },
          })
        : new Response(path.includes('Ajax') ? weekly : facility)
    }
    const sleep = async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted()
      now = new Date(now.getTime() + ms)
    }
    const reset = async () => {
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await new ReferenceRepository(db).initialize(true)
      await new ReferenceRepository(db).seed(true)
      await control.update({ updatesEnabled: true })
      paths.length = 0
      times.length = 0
    }
    const enqueue = async () => (await jobs.enqueue([target]))[0]
    const job = (id: string) => db.doc(`jobs/${id}`)
    try {
      await t.test(
        'home→facility→week publishes once; later invocation restores session and uses week only',
        async () => {
          await reset()
          const worker = new AcquisitionWorker(
            new WorkerStore(db, projectId, () => now),
            sessions,
            { fetchImpl, sleep },
          )
          const app = createWorkerApp(worker)
          try {
            const task = await enqueue()
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: '/tasks/acquire',
                  payload: { jobId: task.jobId, generation: task.generation },
                })
              ).statusCode,
              200,
            )
            assert.deepEqual(
              paths.map((p) => (p === '/web/' ? 'home' : p.includes('Ajax') ? 'week' : 'facility')),
              ['home', 'facility', 'week'],
            )
            assert.ok(times.slice(1).every((time, i) => time - times[i] >= 2000))
            assert.equal((await job(task.jobId).get()).get('state'), 'succeeded')
            const snapshotId = (await scope.get()).get('latestSnapshotId')
            assert.ok(snapshotId)
            assert.equal((await db.doc(`snapshots/${snapshotId}`).get()).get('slotCount'), 15)
            assert.equal((await db.doc('control/queueCapacity').get()).get('pendingJobCount'), 0)
            assert.equal(
              (
                await app.inject({
                  method: 'POST',
                  url: '/tasks/acquire',
                  payload: { jobId: task.jobId, generation: task.generation },
                })
              ).statusCode,
              200,
            )
            assert.equal(paths.length, 3)
            now = new Date(now.getTime() + 900001)
            const next = await enqueue()
            const otherInstance = new AcquisitionWorker(
              new WorkerStore(db, projectId, () => now),
              new OfficialSessionRepository(db, projectId, () => now),
              { fetchImpl, sleep },
            )
            await otherInstance.run(next, new AbortController().signal)
            assert.equal(paths.length, 4)
            assert.ok(paths[3].includes('Ajax'))
          } finally {
            await app.close()
          }
        },
      )
      await t.test(
        'official rejection is acknowledged only after saved failure; all later work stops',
        async () => {
          await reset()
          const worker = new AcquisitionWorker(
            new WorkerStore(db, projectId, () => now),
            sessions,
            {
              fetchImpl: async () => {
                paths.push('blocked')
                return new Response('private', { status: 403 })
              },
              sleep,
            },
          )
          const app = createWorkerApp(worker)
          try {
            const task = await enqueue()
            const response = await app.inject({
              method: 'POST',
              url: '/tasks/acquire',
              payload: { jobId: task.jobId, generation: task.generation },
            })
            assert.equal(response.statusCode, 200)
            assert.doesNotMatch(response.body, /private|cookie/i)
            assert.equal((await control.get()).get('blockedReason'), 'access-blocked')
            assert.equal((await job(task.jobId).get()).get('state'), 'failed')
            assert.equal((await scope.get()).get('latestSnapshotId'), null)
            assert.equal(paths.length, 1)
          } finally {
            await app.close()
          }
        },
      )
      await t.test(
        'request abort stops HTTP and saves interrupted/recovery state without publication',
        async () => {
          await reset()
          const abort = new AbortController()
          let calls = 0
          const worker = new AcquisitionWorker(
            new WorkerStore(db, projectId, () => now),
            sessions,
            {
              sleep,
              fetchImpl: async (_url, init) => {
                calls++
                abort.abort()
                init?.signal?.throwIfAborted()
                throw new Error('unexpected')
              },
            },
          )
          const task = await enqueue()
          await worker.run(task, abort.signal)
          assert.equal(calls, 1)
          assert.equal((await job(task.jobId).get()).get('state'), 'failed')
          assert.equal((await session.get()).get('restorationState'), 'recovery_required')
          assert.equal((await control.get()).get('owner'), null)
          assert.equal((await scope.get()).get('latestSnapshotId'), null)
        },
      )
      await t.test(
        'heartbeat failure aborts HTTP and returns 503, leaving ownership for safe recovery',
        async () => {
          await reset()
          let began = false,
            aborted = false
          const store = new WorkerStore(db, projectId, () => now)
          store.heartbeat = async () => {
            if (began) throw new Error('private-cookie')
          }
          const worker = new AcquisitionWorker(store, sessions, {
            sleep,
            timing: { abortMs: 10000, deadlineMs: 11000, heartbeatMs: 20, storageMs: 5000 },
            fetchImpl: async (_url, init) => {
              began = true
              return new Promise((_resolve, reject) => {
                init!.signal!.addEventListener(
                  'abort',
                  () => {
                    aborted = true
                    reject(new Error('private-cookie'))
                  },
                  { once: true },
                )
              })
            },
          })
          const app = createWorkerApp(worker)
          try {
            const task = await enqueue()
            const response = await app.inject({
              method: 'POST',
              url: '/tasks/acquire',
              payload: { jobId: task.jobId, generation: task.generation },
            })
            assert.equal(response.statusCode, 503)
            assert.equal(aborted, true)
            assert.doesNotMatch(response.body, /private|cookie/i)
            assert.equal((await job(task.jobId).get()).get('state'), 'running')
            assert.ok((await control.get()).get('owner'))
            assert.equal((await scope.get()).get('latestSnapshotId'), null)
          } finally {
            await app.close()
          }
        },
      )
      await t.test(
        'shortened execution budget aborts in-flight HTTP and records terminal failure',
        async () => {
          await reset()
          let aborted = false
          const worker = new AcquisitionWorker(
            new WorkerStore(db, projectId, () => now),
            sessions,
            {
              sleep,
              timing: { abortMs: 1000, deadlineMs: 5000, heartbeatMs: 100, storageMs: 2000 },
              fetchImpl: async (_url, init) =>
                new Promise((_resolve, reject) => {
                  init!.signal!.addEventListener(
                    'abort',
                    () => {
                      aborted = true
                      reject(new Error('aborted'))
                    },
                    { once: true },
                  )
                }),
            },
          )
          const task = await enqueue()
          await worker.run(task, new AbortController().signal)
          assert.equal(aborted, true)
          assert.equal((await job(task.jobId).get()).get('state'), 'failed')
          assert.equal((await session.get()).get('restorationState'), 'recovery_required')
        },
      )
      await t.test(
        'snapshot write response loss never publishes or acknowledges; expired redelivery performs no HTTP',
        async () => {
          await reset()
          const store = new WorkerStore(db, projectId, () => now)
          const stage = store.snapshots.stage.bind(store.snapshots)
          store.snapshots.stage = async (result) => {
            await stage(result)
            throw new Error('private-storage-error')
          }
          const worker = new AcquisitionWorker(store, sessions, { fetchImpl, sleep })
          const task = await enqueue()
          await assert.rejects(
            worker.run(task, new AbortController().signal),
            /private-storage-error/,
          )
          assert.equal((await scope.get()).get('latestSnapshotId'), null)
          assert.equal((await job(task.jobId).get()).get('state'), 'running')
          assert.equal((await db.collection('snapshots').get()).size, 1)
          now = new Date(now.getTime() + 90001)
          await worker.run(task, new AbortController().signal)
          assert.equal(paths.length, 3)
          assert.equal((await job(task.jobId).get()).get('errorCode'), 'interrupted')
          assert.equal((await control.get()).get('blockedReason'), 'session-recovery-required')
        },
      )
      await t.test(
        'a hanging storage operation stops further HTTP within the storage budget',
        async () => {
          await reset()
          const store = new WorkerStore(db, projectId, () => now)
          const gate = Promise.withResolvers<number>()
          store.gate = async () => gate.promise
          const worker = new AcquisitionWorker(store, sessions, {
            fetchImpl,
            sleep,
            timing: { abortMs: 4000, deadlineMs: 5000, heartbeatMs: 2000, storageMs: 1000 },
          })
          const task = await enqueue()
          await assert.rejects(
            worker.run(task, new AbortController().signal),
            /worker-storage-unavailable/,
          )
          gate.resolve(0)
          assert.equal(paths.length, 0)
          assert.equal((await job(task.jobId).get()).get('state'), 'running')
          assert.equal((await scope.get()).get('latestSnapshotId'), null)
        },
      )
    } finally {
      try {
        for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      } finally {
        await db.terminate()
      }
    }
  },
)
