import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import routes from '../src/routes/availability'
import { ApiError } from '../src/availability-api/input'
import { RequestLimits } from '../src/availability-api/controls'

const unavailable = async (): Promise<never> => {
  throw new ApiError(503, 'storage_unavailable', '保存先を利用できません。')
}
const input = { targets: [{ parkId: '1280', surface: 'grass' }] }
test('fixed windows limit endpoint groups independently and reset after one minute', () => {
  let now = 0
  const limits = new RequestLimits(() => now)
  const quotas = [
    ['search', 60],
    ['job', 300],
    ['updates', 12],
    ['parks', 60],
  ] as const
  for (const [kind, count] of quotas) {
    for (let i = 0; i < count; i++) assert.equal(limits.retryAfter(kind), 0)
  }
  now = 1250
  for (const [kind] of quotas) assert.equal(limits.retryAfter(kind), 59)
  now = 60000
  for (const kind of ['search', 'job', 'updates', 'parks'] as const)
    assert.equal(limits.retryAfter(kind), 0)
})

test('HTTP rate limit returns Retry-After and refuses service access before database work', async () => {
  const app = Fastify()
  let reads = 0
  try {
    await app.register(routes, {
      prefix: '/api/availability',
      service: {
        parks: unavailable,
        job: unavailable,
        updates: unavailable,
        search: async () => {
          reads++
          return unavailable()
        },
      },
    })
    const search = () =>
      app.inject({ method: 'POST', url: '/api/availability/search', payload: input })
    for (let i = 0; i < 60; i++) assert.equal((await search()).statusCode, 503)
    const denied = await search()
    assert.equal(denied.statusCode, 429)
    assert.equal(denied.json().error.code, 'rate_limited')
    assert.equal(denied.headers['cache-control'], 'no-store')
    assert.ok(Number(denied.headers['retry-after']) > 0)
    assert.equal(reads, 60)
    assert.equal((await app.inject('/api/availability/parks')).statusCode, 503)
  } finally {
    await app.close()
  }
})

test('request timeout returns safe 503 without waiting for a stuck service', async (t) => {
  const app = Fastify()
  const entered = Promise.withResolvers<void>()
  try {
    await app.register(routes, {
      prefix: '/api/availability',
      service: {
        parks: unavailable,
        job: unavailable,
        updates: unavailable,
        search: async () => {
          entered.resolve()
          return new Promise<never>(() => {})
        },
      },
    })
    await app.ready()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = app.inject({ method: 'POST', url: '/api/availability/search', payload: input })
    // inject is lazy: start it before advancing the clock.
    const responsePromise = Promise.resolve(pending)
    await entered.promise
    t.mock.timers.tick(30000)
    const response = await responsePromise
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().error.code, 'request_timeout')
  } finally {
    t.mock.timers.reset()
    await app.close()
  }
})
