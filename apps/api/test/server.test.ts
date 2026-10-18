import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeApp, serverSettings } from '../src/server'

test('runtime requires a known production role and a valid port; production binds all interfaces', () => {
  assert.deepEqual(serverSettings({}), { role: 'api', port: 17591, host: '127.0.0.1' })
  assert.deepEqual(serverSettings({ NODE_ENV: 'production', APP_ROLE: 'worker', PORT: '8081' }), {
    role: 'worker',
    port: 8081,
    host: '0.0.0.0',
  })
  for (const env of [
    { NODE_ENV: 'production' },
    { APP_ROLE: 'both' },
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '123abc' },
  ])
    assert.throws(() => serverSettings(env), /invalid-server-settings/)
})

test('public runtime serves /api consistently and never exposes worker routes', async () => {
  const api = createRuntimeApp({ role: 'api' })
  try {
    for (const url of ['/health', '/api/health'])
      assert.equal((await api.inject(url)).statusCode, 200)
    const invalid = await api.inject({
      method: 'POST',
      url: '/api/availability/search',
      payload: {},
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal(
      (await api.inject({ method: 'POST', url: '/tasks/acquire', payload: {} })).statusCode,
      404,
    )
    assert.equal(
      (await api.inject({ method: 'POST', url: '/availability/search', payload: {} })).statusCode,
      404,
    )
  } finally {
    await api.close()
  }
})

test('worker runtime executes the injected worker and exposes no public API', async () => {
  const tasks: object[] = []
  const worker = createRuntimeApp({
    role: 'worker',
    worker: {
      run: async (task) => {
        tasks.push(task)
      },
    },
  })
  try {
    assert.equal((await worker.inject('/health')).statusCode, 200)
    const task = { jobId: 'test-job', generation: 1 }
    assert.equal(
      (await worker.inject({ method: 'POST', url: '/tasks/acquire', payload: task })).statusCode,
      200,
    )
    assert.deepEqual(tasks, [task])
    for (const url of ['/api/availability/search', '/availability/search']) {
      assert.equal((await worker.inject({ method: 'POST', url, payload: {} })).statusCode, 404)
    }
  } finally {
    await worker.close()
  }
})

test('API runtime passes its injected service through app and closes owned dependencies', async () => {
  let reads = 0
  let closed = false
  const unused = async (): Promise<never> => {
    throw new Error('unexpected-service-call')
  }
  const app = createRuntimeApp({
    role: 'api',
    service: {
      parks: async () => {
        reads++
        return { defaultTarget: '1280:grass', groups: [] }
      },
      search: unused,
      updates: unused,
      job: unused,
    },
    close: async () => {
      closed = true
    },
  })
  try {
    const response = await app.inject('/api/availability/parks')
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().defaultTarget, '1280:grass')
    assert.equal(reads, 1)
  } finally {
    await app.close()
  }
  assert.equal(closed, true)
})
