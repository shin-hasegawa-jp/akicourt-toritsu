import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import routes from '../src/routes/availability'
import { migrate, transaction } from '../src/storage/database'
import { Store } from '../src/storage/store'
import { japanToday } from '../src/storage/scopes'
import { offsetDate } from '../src/availability/parser'
import { Result } from '../src/availability/client'

test('API schemas reject invalid input; missing storage returns safe 503', async () => {
  const app = Fastify()
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    await app.register(routes, { prefix: '/availability' })
    const request = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/availability/search', payload: payload as object })
    for (const payload of [
      {},
      { targets: [] },
      { targets: [{ parkId: '1280', surface: 'grass', extra: 1 }] },
      {
        targets: [{ parkId: '1280', surface: 'grass' }],
        dateFrom: '2026-02-30',
        dateTo: '2026-03-01',
      },
      { targets: [{ parkId: '1280', surface: 'grass' }], weekdays: [] },
      { targets: [{ parkId: '1280', surface: 'grass' }], timeFrom: '24:00' },
      { targets: [{ parkId: '1280', surface: 'grass' }], dateFom: '2026-10-10' },
    ]) {
      const response = await request(payload)
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, 'invalid_request')
    }
    const targets = Array.from({ length: 5 }, (_, i) => ({
      parkId: String(1000 + i),
      surface: 'grass',
    }))
    assert.equal((await request({ targets })).statusCode, 503)
    assert.equal(
      (await request({ targets: [...targets, { parkId: '1005', surface: 'grass' }] })).statusCode,
      400,
    )
    assert.equal(
      (await request({ targets: [{ parkId: '1280', surface: 'grass' }] })).statusCode,
      503,
    )
    assert.equal((await app.inject('/availability/updates/not-a-uuid')).statusCode, 400)
  } finally {
    await app.close()
    if (previous !== undefined) process.env.DATABASE_URL = previous
  }
})
test(
  'API search/update contracts against isolated PostgreSQL, without official HTTP',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 5,
    })
    const app = Fastify()
    const store = new Store(pool)
    const owner = randomUUID()
    const target = { parkId: '1280', surface: 'grass' as const }
    const today = japanToday()
    const day = new Date(`${today}T00:00:00Z`).getUTCDay()
    const from = offsetDate(today, (6 - day + 7) % 7)
    const to = offsetDate(from, 6)
    const input = { targets: [target], dateFrom: from, dateTo: to }
    const search = (extra: object = {}) =>
      app.inject({ method: 'POST', url: '/availability/search', payload: { ...input, ...extra } })
    const update = (payload: object = input) =>
      app.inject({ method: 'POST', url: '/availability/updates', payload })
    const originalFetch = globalThis.fetch
    let officialCalls = 0
    globalThis.fetch = async () => {
      officialCalls++
      throw new Error('HTTP must not be used by API')
    }
    try {
      await migrate(pool)
      await app.register(routes, { pool, prefix: '/availability' })
      let response = await search()
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().coverage, 'none')
      assert.equal(response.json().scopes.length, 2)
      assert.equal(response.json().scopes[0].latestAttempt, null)
      const defaultSearch = await search({ dateFrom: undefined, dateTo: undefined })
      assert.equal(defaultSearch.json().dateFrom, today)
      assert.equal(defaultSearch.json().dateTo, offsetDate(today, 6))
      assert.equal((await update()).statusCode, 503)
      assert.equal(
        (await search({ targets: [{ parkId: '9999', surface: 'grass' }] })).statusCode,
        400,
      )
      assert.equal((await search({ dateTo: offsetDate(from, 7) })).statusCode, 400)
      assert.equal((await search({ targets: [target, target] })).statusCode, 400)
      assert.equal((await search({ timeFrom: '11:00', timeTo: '09:00' })).statusCode, 400)
      assert.equal((await search({ weekdays: [6, 6] })).statusCode, 400)
      assert.equal(
        (await update({ ...input, dateFrom: offsetDate(today, -1), dateTo: today })).statusCode,
        400,
      )
      assert.equal((await update({ ...input, weekdays: [6] })).statusCode, 400)
      assert.equal(
        (await search({ weekdays: [], includeHolidays: true })).json().error.code,
        'holiday_calendar_unavailable',
      )
      // All weekdays do not require holiday metadata, even with includeHolidays.
      assert.equal((await search({ includeHolidays: true })).statusCode, 200)
      await store.takeLease(owner)
      const concurrent = await Promise.all(Array.from({ length: 6 }, () => update()))
      for (const res of concurrent) assert.equal(res.statusCode, 202, res.body)
      assert.equal(
        new Set(
          concurrent.map((res) =>
            res
              .json()
              .jobs.map((j: { jobId: string }) => j.jobId)
              .join(','),
          ),
        ).size,
        1,
      )
      response = await search()
      assert.equal(response.json().scopes[0].latestAttempt.state, 'queued')
      const jobs = concurrent[0].json().jobs
      assert.equal(
        (await app.inject(`/availability/updates/${jobs[0].jobId}`)).json().requestCount,
        0,
      )
      assert.equal((await app.inject(`/availability/updates/${randomUUID()}`)).statusCode, 404)
      const first = (await store.claim(owner))!
      await store.progress(owner, first, 3)
      assert.equal((await app.inject(`/availability/updates/${first.id}`)).json().state, 'running')
      const result: Result = {
        target: { ...target, startDate: first.week_start },
        attemptedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 100,
        requests: [],
        state: 'success',
        facilities: [
          {
            id: '12800020',
            name: 'Synthetic court',
            week: {
              days: Array.from({ length: 7 }, (_, i) => offsetDate(first.week_start, i)),
              checkedCells: 28,
              slots: [
                { date: from, start: '09:00', end: '11:00', availableCourts: 2 },
                { date: from, start: '12:00', end: '13:00', availableCourts: 2 },
                { date: from, start: '13:00', end: '14:00', availableCourts: 2 },
                { date: offsetDate(from, 1), start: '09:00', end: '11:00', availableCourts: 1 },
              ],
            },
          },
        ],
      }
      await store.finish(owner, first, result)
      response = await search()
      assert.equal(response.json().coverage, 'partial')
      assert.equal(response.json().slots.length, 4)
      const published = randomUUID()
      const secondScope = (
        await pool.query('SELECT id FROM acquisition_scopes WHERE week_start=$1', [
          offsetDate(first.week_start, 7),
        ])
      ).rows[0].id
      let switched = false
      const intercept = (client: PoolClient): void => {
        const execute = client.query.bind(client)
        client.query = ((...args: unknown[]) => {
          if (
            !switched &&
            typeof args[0] === 'string' &&
            args[0].startsWith('SELECT f.facility_id')
          ) {
            switched = true
            client.query = execute
            return (async () => {
              await transaction(pool, async (writer) => {
                await writer.query(
                  'INSERT INTO snapshots VALUES($1,$2,clock_timestamp(),clock_timestamp(),1,28)',
                  [published, secondScope],
                )
                await writer.query(
                  "INSERT INTO snapshot_facilities VALUES($1,'12800020','Concurrent empty snapshot')",
                  [published],
                )
                await writer.query(
                  'UPDATE acquisition_scopes SET latest_snapshot_id=$2 WHERE id=$1',
                  [secondScope, published],
                )
              })
              return Reflect.apply(execute, client, args)
            })()
          }
          return Reflect.apply(execute, client, args)
        }) as typeof client.query
      }
      pool.on('acquire', intercept)
      try {
        const consistent = await search()
        assert.equal(switched, true)
        assert.equal(consistent.json().coverage, 'partial')
        assert.equal(consistent.json().scopes[1].snapshotId, null)
        assert.equal(consistent.json().slots.length, 4)
      } finally {
        pool.removeListener('acquire', intercept)
      }
      assert.equal((await search()).json().coverage, 'complete')
      await pool.query('UPDATE acquisition_scopes SET latest_snapshot_id=NULL WHERE id=$1', [
        secondScope,
      ])
      assert.equal(
        (
          await search({
            weekdays: [6],
            timeFrom: '09:00',
            timeTo: '11:00',
            minDurationMinutes: 120,
          })
        ).json().slots.length,
        1,
      )
      assert.equal(
        (
          await search({
            weekdays: [6],
            timeFrom: '12:00',
            timeTo: '14:00',
            minDurationMinutes: 120,
          })
        ).json().slots.length,
        0,
      )
      assert.equal((await search({ weekdays: [0] })).json().slots.length, 1)
      assert.equal((await search({ weekdays: [1] })).json().slots.length, 0)
      const year = Number(from.slice(0, 4))
      await pool.query('INSERT INTO holidays VALUES($1,$2,$3,clock_timestamp())', [
        from,
        'Synthetic holiday',
        'test',
      ])
      // Nonempty holiday rows are still incomplete until the entire year is published.
      assert.equal((await search({ weekdays: [], includeHolidays: true })).statusCode, 503)
      for (const y of new Set([year, Number(to.slice(0, 4))]))
        await pool.query('INSERT INTO holiday_calendar_years(year,source) VALUES($1,$2)', [
          y,
          'synthetic test calendar',
        ])
      assert.equal((await search({ weekdays: [], includeHolidays: true })).json().slots.length, 3)
      assert.equal((await search({ weekdays: [0], includeHolidays: true })).json().slots.length, 4)
      const second = (await store.claim(owner))!
      await store.finish(owner, second, {
        ...result,
        target: { ...target, startDate: second.week_start },
        state: 'failed',
        error: 'timeout',
      })
      const cooling = await update()
      assert.equal(cooling.statusCode, 200, cooling.body)
      assert.ok(
        cooling
          .json()
          .jobs.every((j: { reused: boolean; retryAfter: number }) => j.reused && j.retryAfter > 0),
      )
      await pool.query("UPDATE snapshots SET completed_at=clock_timestamp()-interval '1 hour'")
      await pool.query(
        "UPDATE acquisition_jobs SET cooldown_until=clock_timestamp()-interval '1 second'",
      )
      await update()
      const retry = (await store.claim(owner))!
      await store.finish(owner, retry, { ...result, state: 'failed', error: 'unknown-status' })
      response = await search()
      assert.equal(response.json().scopes[0].dataState, 'stale')
      assert.equal(response.json().scopes[0].latestAttempt.errorCode, 'unknown-status')
      assert.equal(response.json().slots.length, 4)
      const complete = (await store.claim(owner))!
      const empty: Result = {
        ...result,
        target: { ...target, startDate: complete.week_start },
        state: 'success',
        facilities: [
          {
            id: '12800020',
            name: 'Synthetic court',
            week: {
              days: Array.from({ length: 7 }, (_, i) => offsetDate(complete.week_start, i)),
              checkedCells: 28,
              slots: [],
            },
          },
        ],
      }
      await store.finish(owner, complete, empty)
      assert.equal((await search()).json().coverage, 'complete')
      await pool.query(
        "UPDATE acquisition_jobs SET cooldown_until=clock_timestamp()-interval '1 second'",
      )
      await update()
      const clear = (await store.claim(owner))!
      await store.finish(owner, clear, {
        ...empty,
        target: { ...target, startDate: clear.week_start },
        state: 'success',
        facilities: [
          {
            ...empty.facilities[0],
            week: {
              ...empty.facilities[0].week,
              days: Array.from({ length: 7 }, (_, i) => offsetDate(clear.week_start, i)),
            },
          },
        ],
      })
      response = await search()
      assert.equal(response.json().coverage, 'complete')
      assert.deepEqual(response.json().slots, [])
      await pool.query("UPDATE worker_lease SET blocked_reason='access-blocked'")
      assert.equal((await update()).statusCode, 503)
      assert.equal((await search()).statusCode, 200)
      assert.equal(
        (
          await search({
            dateFrom: '2026-12-29',
            dateTo: '2027-01-04',
            weekdays: [],
            includeHolidays: true,
          })
        ).statusCode,
        503,
      )
      const unavailablePool = new Pool({ connectionString: process.env.DATABASE_URL })
      await unavailablePool.end()
      const unavailableApp = Fastify()
      try {
        await unavailableApp.register(routes, { pool: unavailablePool, prefix: '/availability' })
        const outage = await unavailableApp.inject({
          method: 'POST',
          url: '/availability/search',
          payload: input,
        })
        assert.equal(outage.statusCode, 503)
        assert.deepEqual(outage.json(), {
          error: { code: 'storage_unavailable', message: '保存先を利用できません。' },
        })
      } finally {
        await unavailableApp.close()
      }
      assert.equal(
        (await update({ ...input, targets: [{ parkId: '9999', surface: 'grass' }] })).statusCode,
        400,
      )
      const latest = response.json().scopes[0].snapshotId
      await pool.query(
        "INSERT INTO snapshot_facilities SELECT $1,'bulk'||g::text,'Bulk test' FROM generate_series(0,100) g",
        [latest],
      )
      await pool.query(
        "INSERT INTO slots SELECT $1,'bulk'||g::text,$2::date,m,m+1,1 FROM generate_series(0,100) g CROSS JOIN generate_series(0,99) m LIMIT 10001",
        [latest, from],
      )
      const oversized = await search()
      assert.equal(oversized.statusCode, 503)
      assert.equal(oversized.json().error.code, 'response_too_large')
      assert.equal(officialCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)
