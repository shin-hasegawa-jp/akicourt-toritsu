import { connectFirestore } from './firestore/database'
import { ReferenceRepository } from './firestore/reference-data'
import { JobRepository } from './firestore/jobs'
import { CloudTaskDispatcher, dispatchPending } from './firestore/task-dispatcher'

export function parseFirestoreArguments(args: string[]) {
  const [command, ...rest] = args
  if (!['initialize', 'seed-reference-data', 'status', 'repair-outbox'].includes(command))
    throw new Error('invalid-command')
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (flag === '--apply') {
      if (apply || command === 'status') throw new Error('invalid-arguments')
      apply = true
    } else {
      if (
        !['--project', '--database'].includes(flag) ||
        values.has(flag) ||
        !rest[i + 1] ||
        rest[i + 1].startsWith('--')
      )
        throw new Error('invalid-arguments')
      values.set(flag, rest[++i])
    }
  }
  const projectId = values.get('--project')
  const databaseId = values.get('--database')
  if (!projectId || !databaseId) throw new Error('explicit-project-and-database-required')
  return { command, projectId, databaseId, apply }
}

export async function runFirestoreCommand(args: string[]) {
  const { command, projectId, databaseId, apply } = parseFirestoreArguments(args)
  const db = connectFirestore({ projectId, databaseId })
  try {
    if (command === 'repair-outbox') {
      const repository = new JobRepository(db)
      const jobs = await repository.pending()
      if (!apply) return { projectId, databaseId, mode: 'dry-run', action: command, jobs }
      if (process.env.NODE_ENV !== 'production') throw new Error('tasks-production-required')
      const dispatcher = new CloudTaskDispatcher({
        projectId,
        location: process.env.TASKS_LOCATION ?? '',
        queue: process.env.TASKS_QUEUE ?? '',
        callerSA: process.env.TASKS_CALLER_SA ?? '',
        workerUrl: process.env.WORKER_URL ?? '',
      })
      try {
        return {
          projectId,
          databaseId,
          mode: 'apply',
          action: command,
          ...(await dispatchPending(repository, dispatcher, jobs)),
        }
      } finally {
        await dispatcher.close()
      }
    }
    const repository = new ReferenceRepository(db)
    const result =
      command === 'initialize'
        ? await repository.initialize(apply)
        : command === 'seed-reference-data'
          ? await repository.seed(apply)
          : await repository.status()
    return {
      projectId,
      databaseId,
      mode: command === 'status' ? 'read-only' : apply ? 'apply' : 'dry-run',
      ...result,
    }
  } finally {
    await db.terminate()
  }
}

if (require.main === module) {
  runFirestoreCommand(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error(
        'Firestore command failed. Check explicit project/database, emulator settings and initialization state. Commands: initialize | seed-reference-data | status | repair-outbox; writes require --apply.',
      )
      process.exitCode = 1
    },
  )
}
