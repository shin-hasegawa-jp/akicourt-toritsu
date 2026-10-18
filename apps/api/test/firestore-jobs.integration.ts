import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { Target } from '../src/availability/client'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import { AdmissionError, JobRepository } from '../src/storage/firestore/jobs'
import { dispatchPending } from '../src/storage/firestore/task-dispatcher'
import { scopeId } from '../src/storage/firestore/snapshot-codec'

const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-19' }
const other: Target = { parkId: '1040', surface: 'grass', startDate: '2026-10-19' }
test(
  'Firestore job admission and task outbox',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 120000 },
  async (t) => {
    const db = new Firestore({
      ...firestoreSettings({ projectId: 'demo-akicourt-local', databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date('2026-10-18T14:59:00Z')
    const jobs = new JobRepository(db, () => now)
    const queue = db.doc('control/queueCapacity'),
      control = db.doc('control/acquisition')
    const references = new ReferenceRepository(db)
    let first = { jobId: '', generation: 1, reused: false }
    try {
      await references.initialize(true)
      await references.seed(true)
      await t.test('paused and unknown targets refuse admission without jobs', async () => {
        await assert.rejects(jobs.enqueue([target]))
        await control.update({ updatesEnabled: true })
        await assert.rejects(jobs.enqueue([{ ...target, parkId: '9999' }]))
        assert.equal((await db.collection('jobs').get()).size, 0)
      })
      await t.test('concurrent duplicate requests share one job and one reservation', async () => {
        const result = await Promise.all([jobs.enqueue([target]), jobs.enqueue([target])])
        assert.equal(result[0][0].jobId, result[1][0].jobId)
        assert.equal(result.flat().filter((j) => !j.reused).length, 1)
        first = result[0][0]
        assert.equal((await queue.get()).get('pendingJobCount'), 1)
        assert.equal((await db.doc('usage/2026-10-18').get()).get('newJobCount'), 1)
        assert.equal((await jobs.pending()).length, 1)
      })
      await t.test(
        'failure retries the same job; response loss and early completion never regress state',
        async () => {
          const names: string[] = []
          await dispatchPending(
            jobs,
            {
              submit: async (j) => {
                names.push(j.jobId)
                throw new Error('lost-response')
              },
            },
            [first],
          )
          assert.equal((await db.doc(`jobs/${first.jobId}`).get()).get('dispatchState'), 'pending')
          const retry = (await jobs.enqueue([target]))[0]
          assert.equal(retry.jobId, first.jobId)
          await dispatchPending(
            jobs,
            {
              submit: async (j) => {
                names.push(j.jobId)
              },
            },
            [retry],
          )
          assert.deepEqual(names, [first.jobId, first.jobId])
          assert.equal(
            (await db.doc(`jobs/${first.jobId}`).get()).get('dispatchState'),
            'submitted',
          )
          assert.equal((await queue.get()).get('pendingJobCount'), 1)
          const [second] = await jobs.enqueue([other])
          await dispatchPending(
            jobs,
            {
              submit: async () => {
                // Synthetic terminal writer: real owner/fence and publication integration is FS-2c.
                await db.runTransaction(async (tx) => {
                  const release = await jobs.prepareCapacityRelease(tx, second.jobId)
                  release()
                  tx.update(db.doc(`jobs/${second.jobId}`), {
                    state: 'failed',
                    errorCode: 'test-failure',
                    cooldownUntil: Timestamp.fromMillis(now.getTime() + 900000),
                  })
                  tx.update(db.doc(`scopes/${scopeId(other)}`), {
                    cooldownUntil: Timestamp.fromMillis(now.getTime() + 900000),
                  })
                })
              },
            },
            [second],
          )
          assert.equal((await db.doc(`jobs/${second.jobId}`).get()).get('state'), 'failed')
          const [reuse] = await jobs.enqueue([other])
          assert.equal(reuse.jobId, second.jobId)
          assert.equal(reuse.reused, true)
          await db.runTransaction(async (tx) =>
            (await jobs.prepareCapacityRelease(tx, second.jobId))(),
          )
          assert.equal((await queue.get()).get('pendingJobCount'), 1)
          now = new Date(now.getTime() + 900000)
          assert.notEqual((await jobs.enqueue([other]))[0].jobId, second.jobId)
        },
      )
      await t.test('queue limit rejects the entire request; reuse works at the limit', async () => {
        const limited = new JobRepository(db, () => now, { pending: 2, daily: 100 })
        const before = (await db.collection('jobs').get()).size
        await assert.rejects(
          limited.enqueue([target, { ...target, startDate: '2026-10-26' }]),
          (e) =>
            e instanceof AdmissionError &&
            e.code === 'queue_capacity_exceeded' &&
            e.retryAfter === 30,
        )
        assert.equal((await db.collection('jobs').get()).size, before)
        assert.equal((await limited.enqueue([target]))[0].jobId, first.jobId)
      })
      await t.test(
        'JST daily counters reset at midnight but pending reservations do not',
        async () => {
          const before = (await queue.get()).get('pendingJobCount')
          // Time has crossed the JST day boundary in the previous test.
          assert.equal(now.toISOString(), '2026-10-18T15:14:00.000Z')
          assert.equal((await db.doc('usage/2026-10-18').get()).get('newJobCount'), 2)
          assert.equal((await db.doc('usage/2026-10-19').get()).get('newJobCount'), 1)
          const limited = new JobRepository(db, () => now, { pending: 20, daily: 1 })
          await assert.rejects(
            limited.enqueue([{ ...target, startDate: '2026-10-26' }]),
            (e) =>
              e instanceof AdmissionError &&
              e.code === 'daily_job_limit_exceeded' &&
              e.retryAfter === 85560,
          )
          assert.equal((await queue.get()).get('pendingJobCount'), before)
          assert.equal((await limited.enqueue([target]))[0].reused, true)
        },
      )
      await t.test(
        'different concurrent requests cannot exceed the shared pending limit',
        async () => {
          const limited = new JobRepository(db, () => now, { pending: 3, daily: 100 })
          const result = await Promise.allSettled([
            limited.enqueue([{ ...target, startDate: '2026-11-02' }]),
            limited.enqueue([{ ...target, startDate: '2026-11-09' }]),
          ])
          assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1)
          assert.equal(result.filter((r) => r.status === 'rejected').length, 1)
          assert.equal((await queue.get()).get('pendingJobCount'), 3)
        },
      )
      await t.test(
        'generation mismatch and stopped/corrupt control cannot change counters',
        async () => {
          await jobs.submitted({ ...first, generation: 999 })
          assert.equal(await jobs.dispatchable({ ...first, generation: 999 }), false)
          await control.update({ updatesEnabled: false, blockedReason: 'manual-pause' })
          await assert.rejects(jobs.enqueue([target]))
          await control.update({ updatesEnabled: true, blockedReason: null })
          await queue.update({ pendingJobCount: -1 })
          await assert.rejects(jobs.enqueue([target]), /invalid-job-storage/)
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
