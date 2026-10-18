import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { CookieJar } from 'tough-cookie'
import { Administration } from '../src/storage/firestore/administration'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import { WorkerStore } from '../src/storage/firestore/worker-store'
import { JobRepository } from '../src/storage/firestore/jobs'

test(
  'Firestore operator controls and session recovery',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST, timeout: 120000 },
  async (t) => {
    const db = new Firestore({
      ...firestoreSettings({ projectId: 'demo-akicourt-local', databaseId: '(default)' }),
      databaseId: `test-${randomUUID()}`,
    })
    let now = new Date()
    const admin = new Administration(db, () => now)
    const control = db.doc('control/acquisition'),
      session = db.doc('officialSessions/current')
    const reset = async () => {
      for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      await new ReferenceRepository(db).initialize(true)
    }
    const saved = async () =>
      JSON.stringify([(await control.get()).data(), (await session.get()).data()])
    const privateSession = async () => {
      const jar = new CookieJar()
      jar.setCookieSync(
        'SESSION=private-cookie; Secure; Path=/',
        'https://kouen.sports.metro.tokyo.lg.jp/web/',
      )
      await session.update({
        cookieJar: jar.serializeSync(),
        initialized: true,
        prepared: ['1280/grass'],
        targets: [
          {
            key: '1280/grass',
            parkName: 'private-park',
            facilities: [{ id: '12800020', name: 'private-facility' }],
          },
        ],
      })
    }
    try {
      await t.test(
        'dry-run makes no writes and status never returns Cookie or facility information',
        async () => {
          assert.deepEqual(await admin.status(), { initialized: false })
          await reset()
          await privateSession()
          const before = await saved()
          for (const command of ['resume', 'session-clear'] as const) {
            assert.equal((await admin.execute(command)).applied, false)
            assert.equal(await saved(), before)
          }
          const status = await admin.status()
          assert.equal(status.sessionUsable, true)
          assert.doesNotMatch(JSON.stringify(status), /private|cookieJar|prepared|targets/)
        },
      )
      await t.test(
        'pause works during acquisition; session edits and resume require fully released ownership',
        async () => {
          await reset()
          await new ReferenceRepository(db).seed(true)
          await admin.execute('resume', { apply: true })
          const target = { parkId: '1280', surface: 'grass' as const, startDate: '2026-10-12' }
          const task = (await new JobRepository(db, () => now).enqueue([target]))[0]
          const store = new WorkerStore(db, 'demo-akicourt-local', () => now)
          const claim = await store.claim(task)
          assert.ok(claim)
          await admin.execute('pause')
          assert.equal((await control.get()).get('updatesEnabled'), true)
          await admin.execute('pause', { apply: true })
          await assert.rejects(store.gate(claim), /updates-disabled/)
          await assert.rejects(store.heartbeat(claim), /updates-disabled/)
          for (const command of ['resume', 'session-clear'] as const)
            await assert.rejects(
              admin.execute(command, { apply: true, confirmWorkerStopped: true }),
              /worker-not-released/,
            )
          now = new Date(now.getTime() + 90001)
          await assert.rejects(
            admin.execute('session-clear', { apply: true, confirmWorkerStopped: true }),
            /worker-not-released/,
          )
          await store.claim(task)
          assert.equal((await control.get()).get('owner'), null)
          assert.equal((await db.doc(`jobs/${task.jobId}`).get()).get('errorCode'), 'interrupted')
        },
      )
      await t.test(
        'clear removes Cookie/preparation, retains waiting and diagnostic reason; resume performs the only release',
        async () => {
          await reset()
          await privateSession()
          const later = Timestamp.fromMillis(now.getTime() + 1800000)
          await session.update({
            initializationRetryAt: later,
            initializationError: 'invalid-home',
          })
          await control.update({
            blockedReason: 'session-recovery-required',
            nextRequestNotBefore: later,
          })
          await db.doc('scopes/preserved').set({ cooldownUntil: later })
          await db.doc('usage/preserved').set({ newJobCount: 50 })
          {
            const command = 'session-clear' as const
            const before = await saved()
            await assert.rejects(admin.execute(command, { apply: true }), /confirmation-required/)
            assert.equal(await saved(), before)
            const previous = (await session.get()).get('sessionGeneration')
            await admin.execute(command, { apply: true, confirmWorkerStopped: true })
            const current = await session.get()
            assert.equal(current.get('sessionGeneration'), previous + 1)
            assert.deepEqual(current.get('cookieJar.cookies'), [])
            assert.deepEqual(current.get('prepared'), [])
            assert.deepEqual(current.get('targets'), [])
            assert.equal(current.get('initialized'), false)
            assert.equal(current.get('inFlight'), null)
            assert.equal(current.get('initializationRetryAt').toMillis(), later.toMillis())
            assert.equal(current.get('initializationError'), 'invalid-home')
            assert.equal((await control.get()).get('blockedReason'), 'session-recovery-required')
            assert.equal((await control.get()).get('updatesEnabled'), false)
          }
          await assert.rejects(admin.execute('resume', { apply: true }), /cooldown-active/)
          now = new Date(later.toMillis())
          await admin.execute('resume', { apply: true })
          assert.equal((await control.get()).get('updatesEnabled'), true)
          assert.equal((await control.get()).get('blockedReason'), null)
          assert.equal(
            (await db.doc('scopes/preserved').get()).get('cooldownUntil').toMillis(),
            later.toMillis(),
          )
          assert.equal((await db.doc('usage/preserved').get()).get('newJobCount'), 50)
          await assert.rejects(
            admin.execute('session-clear', { apply: true, confirmWorkerStopped: true }),
            /pause-required/,
          )
        },
      )
      await t.test(
        'invalid Cookie can be explicitly recovered from valid metadata without exposing the input',
        async () => {
          await reset()
          await session.update({
            cookieJar: { private: 'private-cookie' },
            inFlight: { private: 'private-marker' },
          })
          const status = await admin.status()
          assert.equal(status.sessionUsable, false)
          assert.equal(status.restorationState, 'invalid')
          assert.doesNotMatch(JSON.stringify(status), /private/)
          await assert.rejects(admin.execute('resume', { apply: true }))
          await admin.execute('session-clear', { apply: true, confirmWorkerStopped: true })
          assert.equal((await admin.status()).sessionUsable, true)
          assert.equal(
            (await session.get()).get('initializationRetryAt').toMillis(),
            now.getTime() + 900000,
          )
          await session.update({ schemaVersion: 999 })
          const before = await saved()
          await assert.rejects(
            admin.execute('session-clear', { apply: true, confirmWorkerStopped: true }),
            /invalid-admin-state/,
          )
          assert.equal(await saved(), before)
        },
      )
      await t.test(
        'concurrent resume and clear cannot enable acquisition before the waiting deadline',
        async () => {
          await reset()
          const outcomes = await Promise.allSettled([
            admin.execute('resume', { apply: true }),
            admin.execute('session-clear', { apply: true, confirmWorkerStopped: true }),
          ])
          assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
          const status = await admin.status()
          assert.ok(!status.updatesEnabled || status.sessionUsable)
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
