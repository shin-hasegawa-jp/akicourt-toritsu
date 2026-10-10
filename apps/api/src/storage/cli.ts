import { database, migrate } from './database'
import { Store } from './store'
import { japanToday, scopes } from './scopes'
import { work } from './worker'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!['migrate', 'enqueue', 'worker', 'reset-block'].includes(command || ''))
    throw new Error(
      'Usage: storage migrate | enqueue PARK:grass|hard [PARK:grass|hard] [--from YYYY-MM-DD --to YYYY-MM-DD] | worker [--once] | reset-block',
    )
  const pool = database()
  // Do not print pg errors containing connection details.
  pool.on('error', () => console.error('database-unavailable'))
  const store = new Store(pool)
  try {
    if (command === 'migrate') {
      await migrate(pool)
      console.log('Migrations applied')
    }
    if (command === 'enqueue') {
      const targets = []
      let from: string | undefined
      let to: string | undefined
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--from') {
          if (from !== undefined || !args[i + 1]) throw new Error('invalid-arguments')
          from = args[++i]
        } else if (args[i] === '--to') {
          if (to !== undefined || !args[i + 1]) throw new Error('invalid-arguments')
          to = args[++i]
        } else {
          const match = /^(\d{4}):(grass|hard)$/.exec(args[i])
          if (!match) throw new Error('invalid-arguments')
          targets.push({ parkId: match[1], surface: match[2] as 'grass' | 'hard' })
        }
      }
      if ((from === undefined) !== (to === undefined) || (from && from < japanToday()))
        throw new Error('invalid-dates')
      console.log(JSON.stringify(await store.enqueue(scopes(targets, from, to)), null, 2))
    }
    if (command === 'worker') {
      if (args.some((a) => a !== '--once')) throw new Error('invalid-arguments')
      const controller = new AbortController()
      const stop = (): void => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        await work(store, controller.signal, {}, args.includes('--once'))
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    }
    if (command === 'reset-block') {
      await store.resetBlock()
      console.log('Block reset; review the cause before starting the worker')
    }
  } finally {
    await pool.end()
  }
}
void main().catch(() => {
  console.error(
    'Storage command failed. Check arguments, database availability, migration status and worker ownership.',
  )
  process.exitCode = 1
})
