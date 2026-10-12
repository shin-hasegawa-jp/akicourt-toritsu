import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import { Pool } from 'pg'
import referenceData from '../src/plugins/reference-data'
import { prepareStorage } from '../src/storage/sync-reference-data'
import parks from '../src/storage/park-options'
import { Store } from '../src/storage/store'

test('deployment park catalog matches the reviewed official options', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'availability/fixtures/official-parks.json'), 'utf8'),
  )
  assert.deepEqual(
    parks,
    Object.entries({ hard: fixture.hard, grass: fixture.grass }).flatMap(([surface, rows]) =>
      (rows as { id: string; name: string }[]).map(({ id, name }) => ({
        parkId: id,
        surface,
        name,
      })),
    ),
  )
})

test(
  'API startup synchronizes masters; repetition, history and atomic rollback',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const previous = process.env.DATABASE_URL!
    const schema = `test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: previous })
    await admin.query(`CREATE SCHEMA ${schema}`)
    const url = new URL(previous)
    url.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: url.toString() })
    const boot = async () => {
      const app = Fastify()
      try {
        await app.register(referenceData)
        await app.ready()
      } finally {
        await app.close()
      }
    }
    try {
      process.env.DATABASE_URL = url.toString()
      await boot()
      assert.equal((await pool.query('SELECT count(*) FROM holidays')).rows[0].count, '35')
      const [job] = await new Store(pool).enqueue([
        { parkId: '1280', surface: 'grass', startDate: '2026-10-12' },
      ])
      await pool.query(
        "UPDATE park_surfaces SET name='wrong',enabled=false WHERE park_id='1280'; INSERT INTO park_surfaces VALUES('9999','grass','removed',true)",
      )
      await pool.query(
        "INSERT INTO holidays VALUES('2028-01-01','obsolete','test',clock_timestamp()); INSERT INTO holiday_calendar_years(year,source) VALUES(2028,'test')",
      )
      await Promise.all([prepareStorage(pool), prepareStorage(pool)])
      await boot()
      assert.deepEqual(
        (await pool.query("SELECT name,enabled FROM park_surfaces WHERE park_id='1280'")).rows,
        [{ name: '東大和南公園', enabled: true }],
      )
      assert.equal(
        (await pool.query("SELECT enabled FROM park_surfaces WHERE park_id='9999'")).rows[0]
          .enabled,
        false,
      )
      assert.equal(
        (await pool.query('SELECT id FROM acquisition_jobs WHERE id=$1', [job.id])).rowCount,
        1,
      )
      assert.deepEqual(
        (await pool.query('SELECT year FROM holiday_calendar_years ORDER BY year')).rows,
        [{ year: 2026 }, { year: 2027 }],
      )
      assert.equal((await pool.query('SELECT count(*) FROM holidays')).rows[0].count, '35')
      await pool.query("UPDATE park_surfaces SET name='before failure' WHERE park_id='1280'")
      const before = (await pool.query('SELECT * FROM holidays ORDER BY use_date')).rows
      await pool.query(`CREATE FUNCTION reject_sync() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
        CREATE TRIGGER reject_sync BEFORE INSERT ON holidays FOR EACH ROW EXECUTE FUNCTION reject_sync()`)
      await assert.rejects(boot(), /reference-data-sync-failed/)
      assert.equal(
        (await pool.query("SELECT name FROM park_surfaces WHERE park_id='1280'")).rows[0].name,
        'before failure',
      )
      assert.deepEqual((await pool.query('SELECT * FROM holidays ORDER BY use_date')).rows, before)
    } finally {
      process.env.DATABASE_URL = previous
      await pool.end()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  },
)
