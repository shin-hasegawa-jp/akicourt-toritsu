import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { Result, Target } from '../src/availability/client'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import { JobRepository } from '../src/storage/firestore/jobs'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { OfficialSessionRepository } from '../src/storage/firestore/official-session'
import { scopeId } from '../src/storage/firestore/snapshot-codec'
import { syntheticResult } from './firestore-fixtures'

const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-12' }

test(
  'Firestore worker ownership and atomic completion',
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
    timeout: 120000,
  },
  async (t) => {
    const projectId = 'demo-akicourt-local'
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date('2026-10-18T00:00:00Z')
    const jobs = new JobRepository(db, () => now)
    const store = new WorkerStore(db, projectId, () => now)
    const sessions = new OfficialSessionRepository(db, projectId, () => now)
    const control = db.doc('control/acquisition'),
      queue = db.doc('control/queueCapacity'),
      session = db.doc('officialSessions/current')
    const scope = db.doc(`scopes/${scopeId(target)}`)
    const reset = async () => {
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await new ReferenceRepository(db).initialize(true)
      await new ReferenceRepository(db).seed(true)
      await control.update({ updatesEnabled: true })
    }
    const enqueue = async (forTarget = target) => (await jobs.enqueue([forTarget]))[0]
    const claim = async () => {
      const task = await enqueue()
      const claimed = await store.claim(task)
      assert.ok(claimed)
      return claimed
    }
    const failure = (error: string): Result => {
      const result = syntheticResult(target, 1)
      return { ...result, state: 'failed', error }
    }
    try {
      await t.test(
        'concurrent claims have one owner; heartbeat renews both leases and enforces spacing',
        async () => {
          await reset()
          const task = await enqueue()
          const attempts = await Promise.allSettled([store.claim(task), store.claim(task)])
          assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1)
          const winner = attempts.find((a) => a.status === 'fulfilled')
          assert.ok(winner?.status === 'fulfilled' && winner.value)
          const owned = winner.value
          const second = await enqueue({ ...target, parkId: '1040' })
          await assert.rejects(store.claim(second), /worker-busy/)
          const loaded = await sessions.load(owned)
          await loaded.checkpoint(loaded.state, { kind: 'before-request' })
          assert.equal(await store.gate(owned), 2000)
          now = new Date(now.getTime() + 2000)
          assert.equal(await store.gate(owned), 0)
          await store.heartbeat(owned, 1)
          const saved = await db.doc(`jobs/${owned.jobId}`).get()
          assert.equal(saved.get('requestCount'), 1)
          assert.equal(saved.get('leaseUntil').toMillis(), now.getTime() + 90000)
          assert.equal(
            (await control.get()).get('leaseUntil').toMillis(),
            saved.get('leaseUntil').toMillis(),
          )
          await assert.rejects(
            store.heartbeat({ ...owned, fence: owned.fence + 1 }),
            /ownership-lost/,
          )
        },
      )
      await t.test(
        'success publishes snapshot, releases capacity once, and reuses job throughout cooldown',
        async () => {
          await reset()
          const owned = await claim()
          const result = syntheticResult(target, 3)
          const staged = await store.snapshots.stage(result)
          await store.finish(owned, result, staged.snapshotId)
          assert.equal((await scope.get()).get('latestSnapshotId'), staged.snapshotId)
          assert.equal((await scope.get()).get('publicationGeneration'), 1)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          assert.equal((await control.get()).get('owner'), null)
          assert.equal((await db.doc(`jobs/${owned.jobId}`).get()).get('state'), 'succeeded')
          assert.equal((await enqueue()).jobId, owned.jobId)
          // A duplicate delivery must not even need a readable session.
          await session.delete()
          assert.equal(await store.claim(owned), null)
          assert.equal(await store.claim({ ...owned, generation: owned.generation + 1 }), null)
          assert.equal(await store.claim({ jobId: randomUUID(), generation: 0 }), null)
          await store.finish(owned, result, staged.snapshotId)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          assert.equal((await scope.get()).get('publicationGeneration'), 1)
        },
      )
      await t.test(
        'failed refresh retains previous snapshot and does not reset daily usage',
        async () => {
          await reset()
          const first = await claim()
          const result = syntheticResult(target, 1)
          const staged = await store.snapshots.stage(result)
          await store.finish(first, result, staged.snapshotId)
          now = new Date(now.getTime() + 900001)
          const next = await claim()
          await store.finish(next, failure('invalid-response'))
          assert.equal((await scope.get()).get('latestSnapshotId'), staged.snapshotId)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
          const usage = await db.collection('usage').get()
          assert.equal(
            usage.docs.reduce((sum, d) => sum + d.get('newJobCount'), 0),
            2,
          )
        },
      )
      await t.test(
        'paused and globally blocked deliveries terminate without acquiring a session',
        async () => {
          for (const stopped of [
            { updatesEnabled: false },
            { updatesEnabled: false, blockedReason: 'manual-pause' },
          ]) {
            await reset()
            const task = await enqueue()
            const revision = (await session.get()).get('revision')
            await control.update(stopped)
            assert.equal(await store.claim(task), null)
            assert.equal((await db.doc(`jobs/${task.jobId}`).get()).get('state'), 'failed')
            assert.equal((await queue.get()).get('pendingJobCount'), 0)
            assert.equal((await session.get()).get('revision'), revision)
          }
        },
      )
      await t.test('in-flight session cannot be handed to a new job', async () => {
        await reset()
        const task = await enqueue()
        await session.update({
          inFlight: {
            owner: 'old',
            fence: 0,
            requestId: randomUUID(),
            startedAt: Timestamp.fromDate(now),
            phase: 'uncertain',
          },
        })
        assert.equal(await store.claim(task), null)
        assert.equal((await session.get()).get('restorationState'), 'recovery_required')
        assert.equal((await control.get()).get('blockedReason'), 'session-recovery-required')
        assert.equal((await queue.get()).get('pendingJobCount'), 0)
      })
      await t.test(
        'expired worker is interrupted and fenced out; session remains blocked for recovery',
        async () => {
          await reset()
          const owned = await claim()
          const loaded = await sessions.load(owned)
          await loaded.checkpoint(loaded.state, { kind: 'before-request' })
          now = new Date(now.getTime() + 90001)
          assert.equal(await store.claim(owned), null)
          assert.equal((await db.doc(`jobs/${owned.jobId}`).get()).get('errorCode'), 'interrupted')
          assert.equal((await control.get()).get('fence'), owned.fence + 1)
          assert.equal((await session.get()).get('restorationState'), 'recovery_required')
          assert.ok((await scope.get()).get('cooldownUntil').toMillis() >= now.getTime() + 900000)
          await assert.rejects(store.heartbeat(owned), /ownership-lost/)
          await assert.rejects(loaded.checkpoint(loaded.state, { kind: 'state' }), /ownership-lost/)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
        },
      )
      await t.test(
        'aborted or uncertain result blocks reuse; paused/blocked completion never publishes',
        async () => {
          for (const error of ['interrupted', 'session-checkpoint-failed']) {
            await reset()
            const owned = await claim()
            await store.finish(owned, failure(error))
            assert.equal((await control.get()).get('blockedReason'), 'session-recovery-required')
            assert.equal((await control.get()).get('updatesEnabled'), false)
            assert.equal((await queue.get()).get('pendingJobCount'), 0)
            assert.equal((await scope.get()).get('latestSnapshotId'), null)
          }
          await reset()
          const owned = await claim()
          const result = syntheticResult(target, 1)
          const staged = await store.snapshots.stage(result)
          await control.update({ updatesEnabled: false })
          await store.finish(owned, result, staged.snapshotId)
          assert.equal((await scope.get()).get('latestSnapshotId'), null)
          assert.equal((await queue.get()).get('pendingJobCount'), 0)
        },
      )
      await t.test(
        'lost ownership or corrupt counters roll back all publication and completion writes',
        async () => {
          await reset()
          const owned = await claim()
          const result = syntheticResult(target, 1)
          const staged = await store.snapshots.stage(result)
          await control.update({ fence: owned.fence + 1 })
          await assert.rejects(store.finish(owned, result, staged.snapshotId), /ownership-lost/)
          await control.update({ fence: owned.fence })
          await queue.update({ pendingJobCount: 0 })
          await assert.rejects(store.finish(owned, result, staged.snapshotId))
          assert.equal((await scope.get()).get('latestSnapshotId'), null)
          assert.equal((await scope.get()).get('publicationGeneration'), 0)
          assert.equal((await db.doc(`jobs/${owned.jobId}`).get()).get('state'), 'running')
          assert.equal((await control.get()).get('owner'), owned.owner)
        },
      )
      await t.test(
        'a live global lease or changed recovery generation prevents stale work',
        async () => {
          await reset()
          const owned = await claim()
          now = new Date(now.getTime() + 90001)
          await control.update({ leaseUntil: Timestamp.fromMillis(now.getTime() + 90000) })
          await assert.rejects(store.claim(owned), /worker-busy/)
          assert.equal((await db.doc(`jobs/${owned.jobId}`).get()).get('state'), 'running')
          await control.update({ recoveryGeneration: owned.generation + 1 })
          assert.equal(await store.claim(owned), null)
          await assert.rejects(store.heartbeat(owned), /ownership-lost/)
          await assert.rejects(store.finish(owned, failure('interrupted')), /ownership-lost/)
          assert.equal((await queue.get()).get('pendingJobCount'), 1)
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
