import { Pool, PoolClient } from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    max: 5,
  })
}
export async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
export async function migrate(pool: Pool, directory = resolve('migrations')): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(1759103)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    )
    for (const name of (await readdir(directory))
      .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
      .sort()) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])
      if (applied.rowCount) continue
      await client.query(await readFile(resolve(directory, name), 'utf8'))
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
    }
  })
}
