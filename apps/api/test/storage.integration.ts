import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrate } from '../src/storage/database'
import { Store, Job } from '../src/storage/store'
import { japanToday, scopes } from '../src/storage/scopes'
import { acquire, Result } from '../src/availability/client'
import { offsetDate } from '../src/availability/parser'
import { work } from '../src/storage/worker'

void test('Japan date and canonical scopes', () => {
  assert.equal(japanToday(new Date('2026-10-09T15:00:00Z')), '2026-10-10')
  assert.deepEqual(
    scopes([{ parkId: '1280', surface: 'grass' }], '2026-10-10', '2026-10-16').map(
      (t) => t.startDate,
    ),
    ['2026-10-05', '2026-10-12'],
  )
  assert.throws(() => scopes([{ parkId: '1280', surface: 'grass' }], '2026-10-10', '2026-10-17'))
})
void test('403 stops immediately without retry', async () => {
  let count = 0
  const [result] = await acquire([{ parkId: '1280', surface: 'grass', startDate: '2026-10-12' }], {
    fetchImpl: async () => {
      count++
      return new Response('', { status: 403 })
    },
    intervalMs: 0,
  })
  assert.equal(result.state, 'failed')
  if (result.state === 'failed') assert.equal(result.error, 'access-blocked')
  assert.equal(count, 1)
})
void test(
  'storage transactions and worker control (isolated real PostgreSQL schema)',
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
    const store = new Store(pool)
    const target = { parkId: '1280', surface: 'grass' as const, startDate: '2026-10-12' }
    const owner = randomUUID()
    const success = (job: Job, empty = false): Result => ({
      target: { parkId: job.park_id, surface: job.surface, startDate: job.week_start },
      attemptedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      requests: [],
      state: 'success',
      facilities: [
        {
          id: '12800020',
          name: 'Test court',
          week: {
            days: Array.from({ length: 7 }, (_, i) => offsetDate(job.week_start, i)),
            checkedCells: 7,
            slots: empty
              ? []
              : [{ date: job.week_start, start: '09:00', end: '11:00', availableCourts: 2 }],
          },
        },
      ],
    })
    const expireCooldown = async (): Promise<void> => {
      await pool.query(
        "UPDATE acquisition_jobs SET cooldown_until=clock_timestamp()-interval '1 second'",
      )
    }
    const next = async (): Promise<Job> => {
      await expireCooldown()
      await store.enqueue([target])
      return (await store.claim(owner))!
    }
    try {
      await migrate(pool)
      await migrate(pool)
      assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '3')
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.enqueue([target])))
      assert.equal(new Set(concurrent.map((j) => j[0].id)).size, 1)
      assert.equal(concurrent.filter((j) => !j[0].reused).length, 1)
      assert.equal(await store.takeLease(owner), true)
      assert.equal(await store.takeLease(randomUUID()), false)
      let job = (await store.claim(owner))!
      await store.finish(owner, job, success(job))
      const first = (await pool.query('SELECT latest_snapshot_id FROM acquisition_scopes')).rows[0]
        .latest_snapshot_id
      assert.equal((await store.enqueue([target]))[0].id, job.id)
      job = await next()
      const bad = success(job)
      if (bad.state === 'success')
        bad.facilities[0].week.slots.push(bad.facilities[0].week.slots[0])
      await assert.rejects(store.finish(owner, job, bad))
      assert.equal((await pool.query('SELECT count(*) FROM snapshots')).rows[0].count, '1')
      assert.equal(
        (await pool.query('SELECT latest_snapshot_id FROM acquisition_scopes')).rows[0]
          .latest_snapshot_id,
        first,
      )
      await store.finish(owner, job, { ...success(job), state: 'failed', error: 'timeout' })
      assert.equal(
        (await pool.query('SELECT latest_snapshot_id FROM acquisition_scopes')).rows[0]
          .latest_snapshot_id,
        first,
      )
      job = await next()
      await store.finish(owner, job, success(job, true))
      const latest = await pool.query(
        'SELECT count(*) FROM slots WHERE snapshot_id=(SELECT latest_snapshot_id FROM acquisition_scopes)',
      )
      assert.equal(latest.rows[0].count, '0')
      assert.equal((await pool.query('SELECT count(*) FROM slots')).rows[0].count, '1')
      assert.equal(await store.beforeRequest(owner), 0)
      assert.ok((await store.beforeRequest(owner)) > 0)
      job = await next()
      await pool.query("UPDATE worker_lease SET expires_at=clock_timestamp()-interval '1 second'")
      await assert.rejects(store.finish(owner, job, success(job)), /lease-lost/)
      await assert.rejects(store.heartbeat(owner), /lease-lost/)
      const replacement = randomUUID()
      assert.equal(await store.takeLease(replacement), true)
      assert.equal(
        (await pool.query('SELECT error_code FROM acquisition_jobs WHERE id=$1', [job.id])).rows[0]
          .error_code,
        'interrupted',
      )
      await store.release(owner)
      assert.equal((await pool.query('SELECT owner FROM worker_lease')).rows[0].owner, replacement)
      await store.release(replacement)
      await expireCooldown()
      await store.enqueue([target])
      let calls = 0
      await work(
        store,
        new AbortController().signal,
        {
          fetchImpl: async () => {
            calls++
            return new Response('', { status: 429 })
          },
        },
        true,
      )
      assert.equal(calls, 1)
      assert.equal(
        (await pool.query('SELECT blocked_reason FROM worker_lease')).rows[0].blocked_reason,
        'access-blocked',
      )
      await assert.rejects(store.enqueue([target]), /worker-blocked/)
      assert.equal(await store.takeLease(randomUUID()), false)
      await store.resetBlock()
      await expireCooldown()
      await store.enqueue([target])
      const data = JSON.parse(
        readFileSync(join(__dirname, 'availability/fixtures/grass-11.json'), 'utf8'),
      )
      for (const row of data.weekDay) row.useDay += 2
      for (const row of data.result) for (const cell of row.timeResult) cell.useDay += 2
      const wire = (value: unknown): Response =>
        new Response(
          JSON.stringify(value).replace(
            /[^\x00-\x7f]/g,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
          ),
        )
      const starts: number[] = []
      await work(
        store,
        new AbortController().signal,
        {
          fetchImpl: async () => {
            starts.push(Date.now())
            if (starts.length === 1) return new Response('pawab2000')
            if (starts.length === 2)
              return wire({ all: 1, results: [{ bcd: '1280', bcdNm: 'Test' }] })
            if (starts.length === 3)
              return new Response(
                '<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="1280"><select id="facility-select"><option value="12800020_3">Tennis</option></select>',
              )
            return wire(data)
          },
        },
        true,
      )
      assert.equal(starts.length, 4)
      for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2000)
      assert.equal(
        (
          await pool.query(
            'SELECT state,request_count FROM acquisition_jobs ORDER BY queued_at DESC LIMIT 1',
          )
        ).rows[0].state,
        'succeeded',
      )
      assert.equal(
        (
          await pool.query(
            'SELECT request_count FROM acquisition_jobs ORDER BY queued_at DESC LIMIT 1',
          )
        ).rows[0].request_count,
        4,
      )
      await expireCooldown()
      await store.enqueue([target])
      const stop = new AbortController()
      await work(
        store,
        stop.signal,
        {
          fetchImpl: async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              })
              stop.abort()
            }),
        },
        true,
      )
      assert.equal(
        (
          await pool.query(
            'SELECT error_code FROM acquisition_jobs ORDER BY queued_at DESC LIMIT 1',
          )
        ).rows[0].error_code,
        'interrupted',
      )
      await expireCooldown()
      await store.enqueue([target])
      let abortedByLease = false
      await work(
        store,
        new AbortController().signal,
        {
          fetchImpl: async (_url, init) => {
            await pool.query(
              "UPDATE worker_lease SET expires_at=clock_timestamp()-interval '1 second'",
            )
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  abortedByLease = true
                  reject(new Error('aborted'))
                },
                { once: true },
              )
            })
          },
        },
        true,
      )
      assert.equal(abortedByLease, true)
      assert.equal(
        (await pool.query('SELECT state FROM acquisition_jobs ORDER BY queued_at DESC LIMIT 1'))
          .rows[0].state,
        'running',
      )
      const recovered = randomUUID()
      assert.equal(await store.takeLease(recovered), true)
      assert.equal(
        (
          await pool.query(
            'SELECT error_code FROM acquisition_jobs ORDER BY queued_at DESC LIMIT 1',
          )
        ).rows[0].error_code,
        'interrupted',
      )
      await store.release(recovered)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)
