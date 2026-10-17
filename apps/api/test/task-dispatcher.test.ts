import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudTasksClient } from '@google-cloud/tasks'
import {
  CloudTaskDispatcher,
  dispatchPending,
  taskRequest,
} from '../src/storage/firestore/task-dispatcher'

const config = {
  projectId: 'akicourt-prod',
  location: 'asia-northeast1',
  queue: 'acquire',
  callerSA: 'task-caller@akicourt-prod.iam.gserviceaccount.com',
  workerUrl: 'https://worker.example.com',
}
const job = { jobId: 'job_1', generation: 1 }
test('Cloud Tasks contract has stable hashed name, minimal body, OIDC and 900s deadline', async () => {
  const request = taskRequest(config, job)
  assert.deepEqual(JSON.parse(request.task.httpRequest.body.toString()), job)
  assert.equal(request.task.dispatchDeadline.seconds, 900)
  assert.equal(request.task.httpRequest.url, 'https://worker.example.com/tasks/acquire')
  assert.deepEqual(request.task.httpRequest.oidcToken, {
    serviceAccountEmail: config.callerSA,
    audience: config.workerUrl,
  })
  assert.equal(request.task.name, taskRequest(config, job).task.name)
  assert.notEqual(request.task.name, taskRequest(config, { ...job, generation: 2 }).task.name)
  for (const workerUrl of [
    'http://worker.example.com',
    'https://worker.example.com/path',
    'https://user:pass@worker.example.com',
    'https://worker.example.com?x=1',
  ])
    assert.throws(() => taskRequest({ ...config, workerUrl }, job))
  const calls: unknown[] = []
  const client = {
    createTask: async (...args: unknown[]) => {
      calls.push(args)
      throw { code: 6 }
    },
    close: async () => {},
  } as unknown as CloudTasksClient
  const dispatcher = new CloudTaskDispatcher(config, client)
  await dispatcher.submit(job, 1234)
  assert.deepEqual((calls[0] as unknown[])[1], { timeout: 1234, retry: null })
})

test('dispatch failure and response loss reuse the exact task identity', async () => {
  const confirmed = new Set<string>(),
    attempts: string[] = []
  const outbox = {
    dispatchable: async () => true,
    submitted: async (): Promise<void> => {
      throw new Error('db-response-loss')
    },
  }
  const dispatcher = {
    submit: async (j: typeof job) => {
      const id = taskRequest(config, j).task.name
      attempts.push(id)
      confirmed.add(id)
    },
  }
  assert.deepEqual(await dispatchPending(outbox, dispatcher, [job]), { submitted: [] })
  outbox.submitted = async () => {}
  assert.deepEqual(await dispatchPending(outbox, dispatcher, [job]), { submitted: [job.jobId] })
  assert.equal(confirmed.size, 1)
  assert.equal(attempts[0], attempts[1])
  assert.deepEqual(
    await dispatchPending(
      outbox,
      {
        submit: async () => {
          throw new Error('network')
        },
      },
      [job],
    ),
    { submitted: [] },
  )
})

test('ten jobs share a total budget and at most two concurrent submissions', async () => {
  let clock = 0,
    inFlight = 0,
    maximum = 0,
    started = 0
  const outbox = { dispatchable: async () => true, submitted: async () => {} }
  const dispatcher = {
    submit: async (_job: typeof job, timeout: number) => {
      assert.ok(timeout <= 5000)
      started++
      maximum = Math.max(maximum, ++inFlight)
      await Promise.resolve()
      clock += 2500
      inFlight--
    },
  }
  await dispatchPending(
    outbox,
    dispatcher,
    Array.from({ length: 10 }, (_, i) => ({ ...job, jobId: `job_${i}` })),
    { now: () => clock },
  )
  assert.ok(maximum <= 2)
  assert.ok(started < 10)
  assert.ok(clock <= 10000)
})

test('non-responsive and late submissions stay pending without blocking the caller', async () => {
  let submitted = 0,
    resolve: (() => void) | undefined
  const outbox = {
    dispatchable: async () => true,
    submitted: async () => {
      submitted++
    },
  }
  const result = await dispatchPending(
    outbox,
    {
      submit: () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    },
    [job],
    { budgetMs: 30, rpcMs: 10 },
  )
  assert.deepEqual(result, { submitted: [] })
  resolve?.()
  await Promise.resolve()
  assert.equal(submitted, 0)
})

test('timed-out lanes never start extra requests while old RPCs may still be running', async () => {
  let attempts = 0
  const outbox = { dispatchable: async () => true, submitted: async () => {} }
  await dispatchPending(
    outbox,
    {
      submit: () => {
        attempts++
        return new Promise<void>(() => {})
      },
    },
    Array.from({ length: 10 }, (_, i) => ({ jobId: `job_${i}`, generation: 1 })),
    { budgetMs: 50, rpcMs: 10 },
  )
  assert.equal(attempts, 2)
})

test('all ten healthy jobs are registered and ineligible jobs are skipped', async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ({ jobId: `job_${i}`, generation: 1 }))
  let attempts = 0
  const outbox = { dispatchable: async () => true, submitted: async () => {} }
  const dispatcher = {
    submit: async () => {
      attempts++
    },
  }
  assert.equal((await dispatchPending(outbox, dispatcher, jobs)).submitted.length, 10)
  assert.equal(attempts, 10)
  outbox.dispatchable = async () => false
  assert.equal((await dispatchPending(outbox, dispatcher, jobs)).submitted.length, 0)
  assert.equal(attempts, 10)
})
