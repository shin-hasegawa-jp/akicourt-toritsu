import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import Fastify from 'fastify'
import publicApp from '../src/app'
import { createWorkerApp } from '../src/worker/app'

const task = { jobId: 'job-1', generation: 1 }
test('worker acknowledges persisted outcomes, rejects invalid input and hides infrastructure errors', async () => {
  let calls = 0
  const app = createWorkerApp({
    run: async (value) => {
      assert.deepEqual(value, task)
      calls++
      if (calls === 2) throw new Error('SESSION=private')
    },
  })
  try {
    for (const payload of [
      { ...task, target: {} },
      { jobId: '../private', generation: 1 },
      { ...task, generation: -1 },
    ]) {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/tasks/acquire', payload })).statusCode,
        400,
      )
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/tasks/acquire',
          payload: '{',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
      400,
    )
    assert.equal(calls, 0)
    assert.equal(
      (await app.inject({ method: 'POST', url: '/tasks/acquire', payload: task })).statusCode,
      200,
    )
    const failed = await app.inject({ method: 'POST', url: '/tasks/acquire', payload: task })
    assert.equal(failed.statusCode, 503)
    assert.equal(failed.headers['retry-after'], '30')
    assert.equal(failed.headers['cache-control'], 'no-store')
    assert.doesNotMatch(failed.body, /SESSION|private/)
    assert.equal((await app.inject('/availability/search')).statusCode, 404)
    const api = Fastify()
    try {
      await api.register(publicApp)
      assert.equal(
        (await api.inject({ method: 'POST', url: '/tasks/acquire', payload: task })).statusCode,
        404,
      )
    } finally {
      await api.close()
    }
  } finally {
    await app.close()
  }
})

test(
  'client TCP disconnect aborts the worker while the response is pending',
  { timeout: 5000 },
  async () => {
    const entered = Promise.withResolvers<void>(),
      aborted = Promise.withResolvers<void>()
    const app = createWorkerApp({
      run: async (_task, signal) => {
        entered.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          ),
        )
      },
    })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const client = request(`${address}/tasks/acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      client.on('error', () => {})
      client.end(JSON.stringify(task))
      await entered.promise
      client.destroy()
      await aborted.promise
    } finally {
      await app.close()
    }
  },
)

test(
  'server shutdown aborts active work and removes process signal listeners',
  { timeout: 5000 },
  async () => {
    const entered = Promise.withResolvers<void>()
    const listeners = process.listenerCount('SIGTERM')
    let aborted = false
    const app = createWorkerApp({
      run: async (_task, signal) => {
        entered.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          ),
        )
      },
    })
    try {
      const response = app.inject({ method: 'POST', url: '/tasks/acquire', payload: task })
      await entered.promise
      await app.close()
      await response
      assert.equal(aborted, true)
      assert.equal(process.listenerCount('SIGTERM'), listeners)
    } finally {
      await app.close()
    }
  },
)
