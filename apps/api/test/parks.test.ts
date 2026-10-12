import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrate } from '../src/storage/database'
import { AvailabilityService } from '../src/availability-api/service'
import { Store } from '../src/storage/store'
import { work } from '../src/storage/worker'

test(
  'new Ariake target with maintenance response acquires, saves and searches in isolated DB',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    try {
      await migrate(pool)
      const store = new Store(pool)
      const [job] = await store.enqueue([
        { parkId: '1350', surface: 'hard', startDate: '2026-10-19' },
      ])
      const fixture = readFileSync(
        join(__dirname, 'availability/fixtures/ariake-hard-19.json'),
        'utf8',
      )
      const wire = (text: string) =>
        new Response(
          text.replace(
            /[\u0080-\uffff]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
          ),
        )
      let count = 0
      await work(
        store,
        new AbortController().signal,
        {
          fetchImpl: async () => {
            count++
            if (count === 1) return new Response('pawab2000')
            if (count === 2)
              return new Response(
                '<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="1350"><select id="facility-select"><option value="13500010_3">Hard</option></select>',
              )
            return wire(fixture)
          },
        },
        true,
      )
      assert.equal(count, 3)
      const state = await pool.query(
        'SELECT state,request_count FROM acquisition_jobs WHERE id=$1',
        [job.id],
      )
      assert.deepEqual(state.rows[0], { state: 'succeeded', request_count: 3 })
      const result = await new AvailabilityService(pool).search({
        targets: [{ parkId: '1350', surface: 'hard' }],
        dateFrom: '2026-10-19',
        dateTo: '2026-10-25',
      })
      assert.equal(result.coverage, 'complete')
      assert.equal(result.slots.length, 5)
      assert.ok(result.slots.every((slot) => slot.start !== '07:00'))
      assert.equal(result.slots[0].availableCourts, 5)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)

test(
  'official park catalog migration enables all pairs and existing DB history is retained',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: process.env.DATABASE_URL })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    const store = new Store(pool)
    const service = new AvailabilityService(pool)
    try {
      const official: Record<'hard' | 'grass', { id: string; name: string }[]> = JSON.parse(
        readFileSync(join(__dirname, 'availability/fixtures/official-parks.json'), 'utf8'),
      )
      // Apply existing schema, enqueue one job, then upgrade without losing it.
      const original = readFileSync(join(__dirname, '../migrations/001_storage.sql'), 'utf8')
      await pool.query(original)
      await pool.query(
        "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); INSERT INTO schema_migrations(name) VALUES('001_storage.sql')",
      )
      const [existing] = await store.enqueue([
        { parkId: '1280', surface: 'grass', startDate: '2026-10-12' },
      ])
      await migrate(pool)
      await migrate(pool)
      assert.equal(
        (await pool.query('SELECT count(*) FROM park_surfaces WHERE enabled')).rows[0].count,
        '31',
      )
      assert.equal(
        (await store.enqueue([{ parkId: '1280', surface: 'grass', startDate: '2026-10-12' }]))[0]
          .id,
        existing.id,
      )
      for (const surface of ['hard', 'grass'] as const) {
        const rows = await pool.query(
          'SELECT park_id AS id,name FROM park_surfaces WHERE surface=$1 AND enabled ORDER BY park_id',
          [surface],
        )
        assert.deepEqual(
          rows.rows,
          [...official[surface]].sort((a, b) => a.id.localeCompare(b.id)),
        )
        for (const park of official[surface]) {
          const result = await service.search({
            targets: [{ parkId: park.id, surface }],
            dateFrom: '2026-10-12',
            dateTo: '2026-10-18',
          })
          assert.equal(result.coverage, 'none')
          assert.deepEqual(result.slots, [])
        }
      }
      await assert.rejects(
        service.search({ targets: [{ parkId: '1000', surface: 'hard' }] }),
        /未対応/,
      )
      const jobs = await store.enqueue([
        { parkId: '1315', surface: 'hard', startDate: '2026-10-12' },
        { parkId: '1315', surface: 'grass', startDate: '2026-10-12' },
      ])
      assert.equal(jobs.length, 2)
      assert.notEqual(jobs[0].id, jobs[1].id)
    } finally {
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)
