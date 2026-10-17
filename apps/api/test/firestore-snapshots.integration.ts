import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { Target } from '../src/availability/client'
import { ApiError, Input, resolveInput } from '../src/availability-api/input'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import { SnapshotRepository } from '../src/storage/firestore/snapshots'
import { FirestoreSearch } from '../src/storage/firestore/search'
import { scopeId, limits } from '../src/storage/firestore/snapshot-codec'
import { syntheticResult } from './firestore-fixtures'

const projectId = 'demo-akicourt-local'
const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-12' }
const input: Input = {
  targets: [{ parkId: '1280', surface: 'grass' }],
  dateFrom: '2026-10-12',
  dateTo: '2026-10-18',
}
const now = new Date('2026-10-17T00:02:00Z')
const code = (name: string) => (error: unknown) => error instanceof ApiError && error.code === name

test(
  'Firestore snapshots and saved availability search',
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
    timeout: 120000,
  },
  async (t) => {
    const db = new Firestore({
      ...firestoreSettings({ projectId, databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    const snapshots = new SnapshotRepository(db, projectId)
    const metrics: { documentReads: number; wireBytes: number; elapsedMs: number }[] = []
    const search = new FirestoreSearch(db, projectId, (m) => metrics.push(m))
    const references = new ReferenceRepository(db)
    const publish = async (
      id: string,
      forTarget = target,
      generation = 0,
      jobId = randomUUID(),
    ) => {
      await db.runTransaction(async (tx) => {
        await snapshots.publish(tx, id, forTarget, generation)
        tx.set(db.doc(`jobs/${jobId}`), {
          schemaVersion: 1,
          scopeId: scopeId(forTarget),
          state: 'succeeded',
          errorCode: null,
          dispatchState: 'submitted',
          queuedAt: Timestamp.fromDate(now),
        })
        tx.update(db.doc(`scopes/${scopeId(forTarget)}`), { latestJobId: jobId })
      })
      return jobId
    }
    try {
      await references.initialize(true)
      await references.seed(true)
      let first = ''
      let firstJob = ''
      await t.test(
        'unavailable differs from successful empty and stale; failure keeps old data',
        async () => {
          const empty = await search.search(input, now)
          assert.equal(empty.coverage, 'none')
          assert.equal(empty.scopes[0].dataState, 'unavailable')
          const staged = await snapshots.stage(syntheticResult(target, 0))
          first = staged.snapshotId
          assert.equal((await search.search(input, now)).coverage, 'none')
          firstJob = await publish(first)
          const successful = await search.search(input, now)
          assert.equal(successful.coverage, 'complete')
          assert.equal(successful.scopes[0].dataState, 'fresh')
          assert.equal(successful.slots.length, 0)
          assert.equal(
            (await search.search(input, new Date('2026-10-17T00:16:00Z'))).scopes[0].dataState,
            'fresh',
          )
          assert.equal(
            (await search.search(input, new Date('2026-10-17T00:16:00.001Z'))).scopes[0].dataState,
            'stale',
          )
          await db
            .doc(`jobs/${firstJob}`)
            .update({ state: 'failed', errorCode: 'invalid-response' })
          const failed = await search.search(input, new Date('2026-10-17T01:00:00Z'))
          assert.equal(failed.scopes[0].dataState, 'stale')
          assert.equal(failed.scopes[0].latestAttempt?.state, 'failed')
          assert.equal(failed.scopes[0].snapshotId, first)
        },
      )
      await t.test(
        'interrupted staging is unpublished; incomplete or missing chunks fail explicitly',
        async (t) => {
          const original = db.batch.bind(db)
          const interception = t.mock.method(db, 'batch', () => {
            const batch = original()
            const commit = batch.commit.bind(batch)
            t.mock.method(batch, 'commit', async () => {
              await commit()
              throw new Error('simulated-response-loss')
            })
            return batch
          })
          await assert.rejects(
            snapshots.stage(syntheticResult(target, 1)),
            /simulated-response-loss/,
          )
          interception.mock.restore()
          const partial = (await db.collection('snapshots').where('complete', '==', false).get())
            .docs[0]
          assert.ok(partial)
          await assert.rejects(publish(partial.id, target, 1), /incomplete-snapshot/)
          assert.equal((await search.search(input, now)).scopes[0].snapshotId, first)
          const staged = await snapshots.stage(syntheticResult(target, 1))
          await db.doc(`snapshots/${staged.snapshotId}/chunks/0000`).delete()
          await assert.rejects(publish(staged.snapshotId, target, 1))
          // Even a corrupt pointer never produces a partial success/empty result.
          await db.doc(`scopes/${scopeId(target)}`).update({ latestSnapshotId: staged.snapshotId })
          await assert.rejects(search.search(input, now), code('storage_unavailable'))
          await db.doc(`scopes/${scopeId(target)}`).update({ latestSnapshotId: first })
        },
      )
      await t.test(
        'generation compare-and-swap rejects an old publisher and reads are consistent',
        async () => {
          const next = await snapshots.stage(syntheticResult(target, 6000))
          assert.ok(next.chunkCount > 1)
          assert.ok(next.maxDocumentBytes < limits.documentBytes)
          const newJob = randomUUID()
          const [, reads] = await Promise.all([
            publish(next.snapshotId, target, 1, newJob),
            Promise.all(Array.from({ length: 5 }, () => search.search(input, now))),
          ])
          for (const result of reads) {
            const isNew = result.scopes[0].snapshotId === next.snapshotId
            assert.equal(result.slots.length, isNew ? 6000 : 0)
            assert.equal(result.scopes[0].latestAttempt?.jobId, isNew ? newJob : firstJob)
            assert.ok(result.slots.every((s) => s.snapshotId === next.snapshotId))
          }
          await assert.rejects(publish(first, target, 1), /publication-conflict/)
          assert.equal(
            (await db.doc(`scopes/${scopeId(target)}`).get()).get('previousSnapshotId'),
            first,
          )
          const filtered = await search.search(
            {
              ...input,
              weekdays: [],
              includeHolidays: true,
              timeFrom: '09:10',
              timeTo: '09:21',
              minDurationMinutes: 1,
            },
            now,
          )
          // 2026-10-12 is a holiday; each of the 60 facilities contributes 11 slots.
          assert.equal(filtered.slots.length, 660)
          await assert.rejects(
            search.search(
              {
                ...input,
                dateFrom: '2028-01-01',
                dateTo: '2028-01-07',
                weekdays: [],
                includeHolidays: true,
              },
              now,
            ),
            code('holiday_calendar_unavailable'),
          )
          await assert.rejects(
            search.search({ ...input, targets: [{ parkId: '9999', surface: 'grass' }] }, now),
            code('invalid_request'),
          )
          const partial = await search.search(
            { ...input, targets: [...input.targets, { parkId: '1040', surface: 'grass' }] },
            now,
          )
          assert.equal(partial.coverage, 'partial')
          assert.equal(partial.scopes[1].dataState, 'unavailable')
        },
      )
      await t.test(
        'read budgets, large documents and oversized responses fail explicitly',
        async () => {
          const limited = new FirestoreSearch(db, projectId, undefined, 40000)
          await assert.rejects(limited.search(input, now), code('search_capacity_exceeded'))
          const hugeTarget: Target = { parkId: '1010', surface: 'grass', startDate: '2026-10-12' }
          const tooBig = syntheticResult(hugeTarget, 1)
          tooBig.facilities[0].name = 'あ'.repeat(200000)
          await assert.rejects(snapshots.stage(tooBig), /snapshot-capacity-exceeded/)
          const big = syntheticResult(hugeTarget, 100)
          big.facilities[0].name = 'あ'.repeat(150000)
          const staged = await snapshots.stage(big)
          assert.ok(staged.maxDocumentBytes < limits.documentBytes)
          await publish(staged.snapshotId, hugeTarget)
          await assert.rejects(
            search.search({ ...input, targets: [{ parkId: '1010', surface: 'grass' }] }, now),
            code('response_too_large'),
          )
        },
      )
      await t.test('dispatch recovery distinguishes normal queues and terminal jobs', async () => {
        const scope = (await db.doc(`scopes/${scopeId(target)}`).get()).data()!
        const ref = db.doc(`jobs/${scope.latestJobId}`)
        await ref.update({
          state: 'queued',
          dispatchState: 'submitted',
          queuedAt: Timestamp.fromMillis(0),
        })
        assert.equal(
          (await search.search(input, now)).scopes[0].latestAttempt?.recoveryRequired,
          false,
        )
        await ref.update({ dispatchState: 'pending' })
        assert.equal(
          (await search.search(input, now)).scopes[0].latestAttempt?.recoveryRequired,
          true,
        )
        await ref.update({ state: 'running', leaseUntil: Timestamp.fromMillis(0) })
        assert.equal(
          (await search.search(input, now)).scopes[0].latestAttempt?.recoveryRequired,
          true,
        )
        await ref.update({ state: 'succeeded', errorCode: null })
        assert.equal(
          (await search.search(input, now)).scopes[0].latestAttempt?.recoveryRequired,
          false,
        )
      })
      await t.test(
        'five targets spanning two weeks accept 10,000 slots but reject 10,001',
        async () => {
          const multiple: Input = {
            targets: [
              { parkId: '1310', surface: 'hard' },
              { parkId: '1315', surface: 'hard' },
              { parkId: '1350', surface: 'hard' },
              { parkId: '1370', surface: 'hard' },
              { parkId: '1000', surface: 'grass' },
            ],
            dateFrom: '2026-10-18',
            dateTo: '2026-10-24',
          }
          const targets = resolveInput(multiple).targets
          for (const scope of targets) {
            const date = scope.startDate === '2026-10-12' ? '2026-10-18' : '2026-10-19'
            const staged = await snapshots.stage(syntheticResult(scope, 1000, date))
            await publish(staged.snapshotId, scope)
          }
          const started = performance.now()
          const result = await search.search(multiple, now)
          assert.equal(result.scopes.length, 10)
          assert.equal(result.slots.length, 10000)
          assert.equal(result.coverage, 'complete')
          assert.ok(performance.now() - started < 45000)
          console.log(
            `Synthetic 10 scopes / 10000 slots: ${JSON.stringify(metrics.at(-1))} (emulator)`,
          )
          const staged = await snapshots.stage(syntheticResult(targets[0], 1001, '2026-10-18'))
          await publish(staged.snapshotId, targets[0], 1)
          await assert.rejects(search.search(multiple, now), code('response_too_large'))
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
