import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { Administration } from '../src/storage/firestore/administration'
import { AcquisitionReset } from '../src/storage/firestore/acquisition-reset'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { OfficialSessionRepository } from '../src/storage/firestore/official-session'
import { firestoreSettings } from '../src/storage/firestore/database'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { JobRepository } from '../src/storage/firestore/jobs'
import { scopeId } from '../src/storage/firestore/snapshot-codec'
import { syntheticResult } from './firestore-fixtures'

const projectId = 'demo-akicourt-local'
const target = { parkId: '1280', surface: 'grass' as const, startDate: '2026-10-12' }
test(
  'Firestore acquisition reset and operator controls',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 120000 },
  async (t) => {
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date()
    const admin = new Administration(db, () => now),
      jobs = new JobRepository(db, () => now),
      store = new WorkerStore(db, projectId, () => now)
    const control = db.doc('control/acquisition'),
      session = db.doc('officialSessions/current'),
      queue = db.doc('control/queueCapacity')
    const calls: string[] = []
    const maintenance = {
      name: 'test-queue',
      pauseAndPurge: async () => {
        assert.equal((await control.get()).get('updatesEnabled'), false)
        const doc = await session.get()
        if (doc.exists) assert.equal(doc.get('restorationState'), 'recovery_required')
        calls.push('pause/purge')
      },
      resume: async () => {
        calls.push('resume')
      },
    }
    const reset = new AcquisitionReset(db, maintenance, () => now)
    const fresh = async () => {
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await new ReferenceRepository(db).initialize(true)
      await new ReferenceRepository(db).seed(true)
      calls.length = 0
    }
    const task = async () => (await jobs.enqueue([target]))[0]
    try {
      await t.test(
        'dry-run does not stop acquisition, purge tasks or expose session data',
        async () => {
          assert.deepEqual(await admin.status(), { initialized: false })
          await fresh()
          await admin.execute('resume', { apply: true })
          await task()
          const before = JSON.stringify([
            (await control.get()).data(),
            (await session.get()).data(),
          ])
          const preview = await reset.run()
          assert.equal(preview.queuedJobs, 1)
          assert.equal(preview.applied, false)
          assert.equal(calls.length, 0)
          assert.equal(
            JSON.stringify([(await control.get()).data(), (await session.get()).data()]),
            before,
          )
          await assert.rejects(reset.run({ apply: true }), /confirmation-required/)
          assert.equal((await control.get()).get('updatesEnabled'), true)
          assert.doesNotMatch(JSON.stringify(await admin.status()), /cookieJar|prepared|targets/)
        },
      )
      await t.test(
        'pause works during acquisition; ordinary resume still requires ownership release',
        async () => {
          await fresh()
          await admin.execute('resume', { apply: true })
          const owned = await store.claim(await task())
          assert.ok(owned)
          await admin.execute('pause')
          assert.equal((await control.get()).get('updatesEnabled'), true)
          await admin.execute('pause', { apply: true })
          await assert.rejects(store.gate(owned), /updates-disabled/)
          await assert.rejects(admin.execute('resume', { apply: true }), /worker-not-released/)
        },
      )
      await t.test(
        'reset ends queued/running jobs, fences old workers and preserves results/reference/daily counts',
        async () => {
          await fresh()
          await admin.execute('resume', { apply: true })
          const tasks = await jobs.enqueue([target, { ...target, parkId: '1040' }])
          const staged = await store.snapshots.stage(syntheticResult(target, 2))
          await db.runTransaction((tx) => store.snapshots.publish(tx, staged.snapshotId, target, 0))
          const owned = await store.claim(tasks[0])
          assert.ok(owned)
          const loaded = await new OfficialSessionRepository(db, projectId, () => now).load(owned)
          await loaded.checkpoint(loaded.state, { kind: 'before-request' })
          const usage = JSON.stringify(
            (await db.collection('usage').get()).docs.map((doc) => doc.data()),
          )
          const parks = (await db.collection('parkSurfaces').get()).size
          const longer = Timestamp.fromMillis(now.getTime() + 1800000)
          await db.doc(`scopes/${scopeId(target)}`).update({ cooldownUntil: longer })
          const result = await reset.run({ apply: true, confirmWorkerStopped: true })
          assert.equal(result.retryNotBefore, longer.toDate().toISOString())
          assert.equal(result.runningJobs, 1)
          assert.equal(result.queuedJobs, 1)
          assert.deepEqual(calls, ['pause/purge'])
          assert.equal((await control.get()).get('owner'), null)
          assert.equal((await control.get()).get('updatesEnabled'), false)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          for (const item of tasks) {
            assert.equal((await db.doc(`jobs/${item.jobId}`).get()).get('state'), 'failed')
            assert.equal(await store.claim(item), null)
          }
          await assert.rejects(store.heartbeat(owned), /ownership-lost/)
          await assert.rejects(loaded.checkpoint(loaded.state, { kind: 'state' }), /ownership-lost/)
          assert.equal(
            (await db.doc(`scopes/${scopeId(target)}`).get()).get('latestSnapshotId'),
            staged.snapshotId,
          )
          assert.equal((await db.doc(`snapshots/${staged.snapshotId}`).get()).exists, true)
          assert.equal((await db.collection('parkSurfaces').get()).size, parks)
          assert.equal(
            JSON.stringify((await db.collection('usage').get()).docs.map((doc) => doc.data())),
            usage,
          )
          const dto = await session.get()
          assert.deepEqual(dto.get('cookieJar.cookies'), [])
          assert.deepEqual(dto.get('prepared'), [])
          assert.deepEqual(dto.get('targets'), [])
          assert.equal(dto.get('inFlight'), null)
          await assert.rejects(admin.execute('resume', { apply: true }), /cooldown-active/)
          now = new Date(Date.parse(result.retryNotBefore))
          await admin.execute('resume', { apply: true })
          const next = await task()
          assert.ok(next.generation > tasks[0].generation)
          assert.ok(await store.claim(next))
        },
      )
      await t.test(
        'queue failure leaves acquisition stopped; retrying reset completes recovery',
        async () => {
          await fresh()
          await admin.execute('resume', { apply: true })
          const pending = await task()
          const failing = new AcquisitionReset(
            db,
            {
              ...maintenance,
              pauseAndPurge: async () => {
                throw new Error('private-sdk-error')
              },
            },
            () => now,
          )
          await assert.rejects(failing.run({ apply: true, confirmWorkerStopped: true }))
          assert.equal((await control.get()).get('updatesEnabled'), false)
          assert.equal((await db.doc(`jobs/${pending.jobId}`).get()).get('state'), 'queued')
          await assert.rejects(
            admin.execute('resume', { apply: true }),
            /session-recovery-required/,
          )
          await reset.run({ apply: true, confirmWorkerStopped: true })
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          assert.equal((await admin.status()).sessionUsable, true)
        },
      )
      await t.test(
        'reset rebuilds missing session/corrupt pending counter and retains longer waiting times',
        async () => {
          await fresh()
          const later = Timestamp.fromMillis(now.getTime() + 1800000)
          await control.update({ nextRequestNotBefore: later })
          await session.delete()
          await queue.update({ pendingJobCount: -1 })
          const result = await reset.run({ apply: true, confirmWorkerStopped: true })
          assert.equal(result.retryNotBefore, later.toDate().toISOString())
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          assert.equal((await admin.status()).sessionUsable, true)
          assert.equal(
            (await session.get()).get('initializationRetryAt').toMillis(),
            later.toMillis(),
          )
        },
      )
      await t.test('reset is bounded and failure never re-enables acquisition', async () => {
        await fresh()
        const batch = db.batch()
        for (let i = 0; i < 101; i++)
          batch.set(db.doc(`jobs/limit-${i}`), {
            state: 'queued',
            scopeId: '1280_grass_2026-10-12',
          })
        await batch.commit()
        await assert.rejects(
          reset.run({ apply: true, confirmWorkerStopped: true }),
          /reset-job-limit-exceeded/,
        )
        assert.equal((await control.get()).get('updatesEnabled'), false)
        assert.equal((await session.get()).get('restorationState'), 'recovery_required')
      })
    } finally {
      try {
        for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      } finally {
        await db.terminate()
      }
    }
  },
)
