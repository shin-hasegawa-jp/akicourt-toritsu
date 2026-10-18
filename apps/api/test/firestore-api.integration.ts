import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Firestore } from '@google-cloud/firestore'
import routes from '../src/routes/availability'
import { FirestoreAvailabilityService } from '../src/availability-api/firestore-service'
import { Input, resolveInput } from '../src/availability-api/input'
import { firestoreSettings } from '../src/storage/firestore/database'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { DispatchJob } from '../src/storage/firestore/jobs'
import parks from '../src/storage/park-options'
import { japanToday } from '../src/storage/scopes'
import { offsetDate } from '../src/availability/parser'
import { syntheticResult } from './firestore-fixtures'

const projectId = 'demo-akicourt-local'
test(
  'public availability API uses Firestore without official HTTP',
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
    timeout: 120000,
  },
  async (t) => {
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date()
    let rejectDispatch = false
    const sent: DispatchJob[] = []
    const dispatcher = {
      submit: async (job: DispatchJob) => {
        sent.push(job)
        if (rejectDispatch) throw new Error('private-sdk-error')
      },
    }
    const app = Fastify()
    const service = new FirestoreAvailabilityService(db, projectId, dispatcher, () => now)
    const store = new WorkerStore(db, projectId, () => now)
    const references = new ReferenceRepository(db)
    const control = db.doc('control/acquisition')
    const date = japanToday()
    const input: Input = {
      targets: [{ parkId: '1280', surface: 'grass' }],
      dateFrom: date,
      dateTo: date,
    }
    const post = (path: string, payload: Input = input) =>
      app.inject({ method: 'POST', url: `/api/availability/${path}`, payload })
    const fresh = async () => {
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await references.initialize(true)
      await references.seed(true)
      await control.update({ updatesEnabled: true })
      rejectDispatch = false
      sent.length = 0
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('official HTTP must not be used by API')
    }
    try {
      await app.register(routes, { service, prefix: '/api/availability' })
      await t.test(
        'uninitialized DB fails safely; explicit seed exposes catalog and unavailable results',
        async () => {
          let response = await post('search')
          assert.equal(response.statusCode, 503)
          assert.equal(response.json().error.code, 'storage_unavailable')
          await fresh()
          const catalog = await app.inject('/api/availability/parks')
          assert.equal(catalog.statusCode, 200)
          assert.equal(catalog.json().defaultTarget, '1280:grass')
          assert.deepEqual(
            catalog
              .json()
              .groups.flatMap(
                (group: { surface: string; parks: { parkId: string; parkName: string }[] }) =>
                  group.parks.map((park) => ({
                    parkId: park.parkId,
                    surface: group.surface,
                    name: park.parkName,
                  })),
              ),
            parks,
          )
          assert.equal(
            catalog.json().groups.flatMap((g: { parks: object[] }) => g.parks).length,
            31,
          )
          response = await post('search')
          assert.equal(response.statusCode, 200, response.body)
          assert.equal(response.json().coverage, 'none')
          assert.equal(response.headers['cache-control'], 'no-store')
          assert.equal(
            (await post('updates', { ...input, targets: [{ parkId: '9999', surface: 'grass' }] }))
              .statusCode,
            400,
          )
          assert.equal(
            (await app.inject(`/api/availability/updates/${randomUUID()}`)).statusCode,
            404,
          )
          assert.equal((await app.inject('/tasks/acquire')).statusCode, 404)
        },
      )
      await t.test(
        'manual resubmission retries pending registration and reuses the same job/reservation',
        async () => {
          await fresh()
          rejectDispatch = true
          const first = await post('updates')
          assert.equal(first.statusCode, 202, first.body)
          const job = first.json().jobs[0]
          assert.equal(job.reused, false)
          assert.equal((await db.doc(`jobs/${job.jobId}`).get()).get('dispatchState'), 'pending')
          rejectDispatch = false
          const retried = await post('updates')
          assert.equal(retried.statusCode, 202)
          assert.equal(retried.json().jobs[0].jobId, job.jobId)
          assert.equal(retried.json().jobs[0].reused, true)
          assert.deepEqual(sent[0], sent[1])
          await post('updates')
          assert.equal(sent.length, 2)
          assert.equal((await db.doc('control/queueCapacity').get()).get('pendingJobCount'), 1)
          assert.equal((await db.doc(`usage/${japanToday(now)}`).get()).get('newJobCount'), 1)
          const progress = await app.inject(`/api/availability/updates/${job.jobId}`)
          assert.equal(progress.statusCode, 200)
          assert.equal(progress.json().state, 'queued')
          assert.equal(progress.headers['cache-control'], 'no-store')
          assert.doesNotMatch(
            progress.body + first.body,
            /cookieJar|private-sdk|generation|dispatchState|recoveryRequired|owner|scopeId|target"/,
          )
          await db
            .doc(`jobs/${job.jobId}`)
            .update({ requestCount: -1, cookieJar: 'private-cookie' })
          const corrupt = await app.inject(`/api/availability/updates/${job.jobId}`)
          assert.equal(corrupt.statusCode, 503)
          assert.doesNotMatch(corrupt.body, /private-cookie|requestCount/)
        },
      )
      await t.test(
        'success is searchable; terminal reuse returns 200 and later failure keeps saved results',
        async () => {
          await fresh()
          const accepted = await post('updates')
          const task = sent[0]
          const claim = await store.claim(task)
          assert.ok(claim)
          const target = resolveInput(input, true).targets[0]
          const result = {
            ...syntheticResult(target, 2, date),
            attemptedAt: now.toISOString(),
            completedAt: now.toISOString(),
          }
          const snapshot = await store.snapshots.stage(result)
          await store.finish(claim, result, snapshot.snapshotId)
          let response = await post('search')
          assert.equal(response.statusCode, 200, response.body)
          assert.equal(response.json().coverage, 'complete')
          assert.equal(response.json().scopes[0].dataState, 'fresh')
          assert.equal(response.json().slots.length, 2)
          assert.equal(response.json().scopes[0].latestAttempt.state, 'succeeded')
          assert.doesNotMatch(response.body, /dispatchState|recoveryRequired|cookieJar/)
          const reused = await post('updates')
          assert.equal(reused.statusCode, 200, reused.body)
          assert.equal(reused.json().jobs[0].jobId, accepted.json().jobs[0].jobId)
          assert.equal(reused.json().jobs[0].reused, true)
          assert.ok(reused.json().jobs[0].retryAfter > 0)
          now = new Date(now.getTime() + 900001)
          await post('updates')
          const next = await store.claim(sent[1])
          assert.ok(next)
          await store.finish(next, {
            ...result,
            state: 'failed',
            error: 'invalid-home',
            completedAt: now.toISOString(),
          })
          response = await post('search')
          assert.equal(response.json().scopes[0].latestAttempt.state, 'failed')
          assert.equal(response.json().scopes[0].snapshotId, snapshot.snapshotId)
          assert.equal(response.json().scopes[0].dataState, 'stale')
          assert.equal(response.json().slots.length, 2)
        },
      )
      await t.test(
        'five targets across weeks create ten jobs; shared limits and pause remain public errors',
        async () => {
          await fresh()
          const day = new Date(`${date}T00:00:00Z`).getUTCDay()
          const from = offsetDate(date, (6 - day + 7) % 7)
          const many: Input = {
            targets: ['1280', '1040', '1310', '1315', '1350'].map((parkId) => ({
              parkId,
              surface: ['1310', '1350'].includes(parkId) ? 'hard' : 'grass',
            })),
            dateFrom: from,
            dateTo: offsetDate(from, 6),
          }
          let response = await post('updates', many)
          assert.equal(response.statusCode, 202, response.body)
          assert.equal(response.json().jobs.length, 10)
          assert.equal(sent.length, 10)
          await db.doc('control/queueCapacity').update({ pendingJobCount: 20 })
          response = await post('updates', {
            ...input,
            targets: [{ parkId: '1000', surface: 'grass' }],
          })
          assert.equal(response.statusCode, 429, response.body)
          assert.equal(response.headers['retry-after'], '30')
          assert.equal(response.json().error.code, 'queue_capacity_exceeded')
          await control.update({ updatesEnabled: false })
          assert.equal((await post('updates')).statusCode, 503)
          assert.equal((await post('search')).statusCode, 200)
          await control.update({ updatesEnabled: true })
          await db.doc('control/queueCapacity').update({ pendingJobCount: 10 })
          await db.doc(`usage/${japanToday(now)}`).update({ newJobCount: 100 })
          response = await post('updates', {
            ...input,
            targets: [{ parkId: '1000', surface: 'grass' }],
          })
          assert.equal(response.statusCode, 429, response.body)
          assert.equal(response.json().error.code, 'daily_job_limit_exceeded')
          assert.ok(Number(response.headers['retry-after']) > 0)
          assert.equal((await db.collection('jobs').get()).size, 10)
        },
      )
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await db.terminate()
    }
  },
)
