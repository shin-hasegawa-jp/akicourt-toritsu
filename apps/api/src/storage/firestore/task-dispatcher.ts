import { QueueConfig } from './task-queue'
import * as v from 'valibot'
import { parseValue } from '../../validation'
import { createHash } from 'node:crypto'
import { CloudTasksClient, protos } from '@google-cloud/tasks'
import { DispatchJob } from './jobs'

const WorkerUrl = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  }),
)
const TaskConfigSchema = v.object({
  ...QueueConfig.entries,
  callerSA: v.pipe(
    v.string(),
    v.regex(/^[a-zA-Z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  ),
  workerUrl: WorkerUrl,
})
export type TaskConfig = v.InferOutput<typeof TaskConfigSchema>
export function taskRequest(config: TaskConfig, job: DispatchJob) {
  const url = new URL(config.workerUrl)
  const parent = `projects/${config.projectId}/locations/${config.location}/queues/${config.queue}`
  const id = createHash('sha256').update(`${job.jobId}/${job.generation}`).digest('hex')
  return {
    parent,
    task: {
      name: `${parent}/tasks/${id}`,
      dispatchDeadline: { seconds: 900 },
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${url.origin}/tasks/acquire`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ jobId: job.jobId, generation: job.generation })),
        oidcToken: { serviceAccountEmail: config.callerSA, audience: url.origin },
      },
    },
  }
}
export interface Dispatcher {
  submit(job: DispatchJob, timeoutMs: number): Promise<void>
}
export class CloudTaskDispatcher implements Dispatcher {
  constructor(
    private readonly config: TaskConfig,
    private readonly client = new CloudTasksClient(),
  ) {
    this.config = parseValue(TaskConfigSchema, config, () => new Error('invalid-task-config'))
  }
  async submit(job: DispatchJob, timeoutMs: number) {
    try {
      await this.client.createTask(taskRequest(this.config, job), {
        timeout: timeoutMs,
        retry: null,
      })
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error // ALREADY_EXISTS confirms registration.
    }
  }
  async close() {
    await this.client.close()
  }
}

export interface Outbox {
  dispatchable(job: DispatchJob): Promise<boolean>
  submitted(job: DispatchJob): Promise<void>
}
// Bound even a non-responsive dispatcher. A late success remains pending and is
// confirmed by the next request using the same deterministic task name.
class DispatchTimeout extends Error {}
async function within<T>(operation: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DispatchTimeout('dispatch-timeout')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
export async function dispatchPending(
  outbox: Outbox,
  dispatcher: Dispatcher,
  jobs: DispatchJob[],
  options: { budgetMs?: number; rpcMs?: number; now?: () => number } = {},
) {
  const clock = options.now ?? (() => performance.now())
  const budget = Math.min(options.budgetMs ?? 10000, 10000)
  const rpc = Math.min(options.rpcMs ?? 5000, 5000)
  if (
    !Number.isFinite(budget) ||
    !Number.isFinite(rpc) ||
    budget <= 0 ||
    rpc <= 0 ||
    jobs.length > 10
  )
    throw new Error('invalid-dispatch-budget')
  const deadline = clock() + budget
  let cursor = 0
  const submitted: string[] = []
  const worker = async () => {
    while (cursor < jobs.length && clock() < deadline) {
      const job = jobs[cursor++]
      try {
        const eligible = await within(() => outbox.dispatchable(job), deadline - clock())
        if (!eligible || clock() >= deadline) continue
        await within(
          () => dispatcher.submit(job, Math.min(rpc, deadline - clock())),
          Math.min(rpc, deadline - clock()),
        )
        if (clock() >= deadline) continue
        await within(() => outbox.submitted(job), deadline - clock())
        submitted.push(job.jobId)
      } catch (error) {
        // A timed-out RPC may still be running: do not start another on this lane.
        if (error instanceof DispatchTimeout) return
        /* Saved jobs stay pending; do not expose dependency errors or secrets. */
      }
    }
  }
  await Promise.all([worker(), worker()])
  return { submitted }
}
