import fp from 'fastify-plugin'
import { database } from '../storage/database'
import { prepareStorage } from '../storage/sync-reference-data'

export default fp(async (fastify) => {
  if (!process.env.DATABASE_URL) return
  const pool = database()
  pool.on('error', () => fastify.log.error('database-unavailable'))
  try {
    await prepareStorage(pool)
  } catch {
    // Avoid exposing connection details from PostgreSQL errors.
    throw new Error('reference-data-sync-failed')
  } finally {
    await pool.end()
  }
})
