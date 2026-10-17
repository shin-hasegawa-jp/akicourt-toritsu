import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Firestore } from '@google-cloud/firestore'
import { ReferenceRepository } from '../src/storage/firestore/reference-data'
import { firestoreSettings } from '../src/storage/firestore/database'
import parks from '../src/storage/park-options'
import calendar from '../src/storage/holiday-calendar'

// Each run owns a separate emulator-only database, never a shared local collection.
test(
  'Firestore reference storage: initialization, publication and consistent reads',
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
    timeout: 120000,
  },
  async (t) => {
    const settings = firestoreSettings({
      projectId: 'demo-akicourt-local',
      databaseId: '(default)',
    })
    const db = new Firestore({ ...settings, databaseId: `test-${randomUUID()}` })
    const repository = new ReferenceRepository(db)
    const source = { parks, calendar, years: [2026, 2027] }
    try {
      await t.test('dry-run does not write; initialization is atomic and repeatable', async () => {
        assert.deepEqual(await repository.status(), { initialized: false })
        assert.equal((await repository.initialize()).applied, false)
        assert.deepEqual(await repository.status(), { initialized: false })
        await assert.rejects(repository.seed(true), /storage-not-initialized/)
        await assert.rejects(repository.read(), /reference-data-not-initialized/)
        const results = await Promise.all([
          repository.initialize(true),
          repository.initialize(true),
        ])
        assert.equal(results.filter((r) => r.applied).length, 1)
        const status = await repository.status()
        assert.equal(status.initialized, true)
        assert.equal(status.updatesEnabled, false)
        assert.equal(status.pendingJobCount, 0)
        assert.equal(status.sessionGeneration, 1)
        assert.equal(JSON.stringify(status).includes('cookieJar'), false)
        await db.doc('control/acquisition').update({ blockedReason: 'access-blocked', fence: 7 })
        await repository.initialize(true)
        assert.equal((await repository.status()).blockedReason, 'access-blocked')
        await db.doc('control/acquisition').update({ updatesEnabled: true })
        await assert.rejects(repository.seed(true), /acquisition-must-be-stopped/)
        await db.doc('control/acquisition').update({ updatesEnabled: false })
      })
      await t.test('incomplete initialization cannot be reset or partially repaired', async () => {
        const sessionRef = db.doc('officialSessions/current')
        const session = (await sessionRef.get()).data()!
        await sessionRef.delete()
        await assert.rejects(repository.initialize(true), /inconsistent-initialization/)
        assert.equal((await db.doc('control/acquisition').get()).get('fence'), 7)
        await sessionRef.create(session)
      })
      await t.test(
        'seed validates complete calendars and dry-run; publication is idempotent',
        async () => {
          assert.equal((await repository.seed()).applied, false)
          await assert.rejects(repository.read(), /reference-data-not-initialized/)
          const badCalendar = structuredClone(calendar)
          badCalendar.years[0].holidays.pop()
          await assert.rejects(
            repository.seed(true, { ...source, calendar: badCalendar }),
            /invalid-holiday-calendar/,
          )
          assert.equal((await db.doc('control/referenceData').get()).exists, false)
          const result = await repository.seed(true)
          assert.equal(result.parks, 31)
          assert.deepEqual(result.years, [2026, 2027])
          const read = await repository.read()
          assert.equal(read.parks.length, 31)
          assert.equal(
            read.years.reduce((n, y) => n + y.count, 0),
            35,
          )
          const before = (await db.doc('parkSurfaces/1280_grass').get()).updateTime
          assert.equal((await repository.seed(true)).changed, false)
          assert.ok(before?.isEqual((await db.doc('parkSurfaces/1280_grass').get()).updateTime!))
          assert.equal((await repository.status()).blockedReason, 'access-blocked')
        },
      )
      await t.test(
        'retired parks remain disabled; history and control are not deleted',
        async () => {
          await db.doc('jobs/history').set({ synthetic: true })
          const smaller = {
            ...source,
            parks: parks.filter((p) => p.parkId !== '1280'),
            years: [2026],
          }
          await repository.seed(true, smaller)
          assert.equal((await db.doc('parkSurfaces/1280_grass').get()).get('enabled'), false)
          assert.equal((await db.doc('jobs/history').get()).exists, true)
          assert.equal((await db.doc('holidayYears/2027').get()).exists, false)
          const read = await repository.read()
          assert.equal(read.parks.length, 30)
          assert.deepEqual(
            read.years.map((y) => y.year),
            [2026],
          )
          await repository.seed(true)
          assert.equal((await repository.read()).parks.length, 31)
        },
      )
      await t.test(
        'corrupt/missing data fails explicitly; publication repairs source data',
        async () => {
          await db.doc('parkSurfaces/1280_grass').update({ name: 'corrupt' })
          await assert.rejects(repository.read())
          await repository.seed(true)
          await db.doc('holidayYears/2027').delete()
          await assert.rejects(repository.read())
          await repository.seed(true)
          assert.equal((await repository.read()).parks.length, 31)
        },
      )
      await t.test('concurrent readers observe one complete reference generation', async () => {
        const changed = { ...source, parks: parks.map((p) => ({ ...p, name: `${p.name}改` })) }
        const old = await repository.seed()
        const next = await repository.seed(false, changed)
        const [, seen] = await Promise.all([
          repository.seed(true, changed),
          Promise.all(Array.from({ length: 6 }, () => repository.read())),
        ])
        for (const read of seen) {
          assert.ok(read.version === old.version || read.version === next.version)
          assert.equal(
            read.parks.every((p) => p.name.endsWith('改')),
            read.version === next.version,
          )
        }
      })
      await t.test('missing controls with existing data cannot be initialized again', async () => {
        await Promise.all(
          ['control/acquisition', 'control/queueCapacity', 'officialSessions/current'].map((path) =>
            db.doc(path).delete(),
          ),
        )
        await assert.rejects(repository.initialize(true), /inconsistent-initialization/)
        assert.equal((await db.doc('control/acquisition').get()).exists, false)
        assert.equal((await db.doc('jobs/history').get()).exists, true)
      })
    } finally {
      // Only this run's named database is removed; never reset the emulator as a whole.
      try {
        for (const collection of await db.listCollections()) await db.recursiveDelete(collection)
      } finally {
        await db.terminate()
      }
    }
  },
)
