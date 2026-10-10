import { test } from 'node:test'
import * as assert from 'node:assert'
import { build } from '../helper'

test('scaffold endpoints are not exposed; health remains available', async (t) => {
  const app = await build(t)

  for (const url of ['/', '/example']) {
    const res = await app.inject({ url })
    assert.equal(res.statusCode, 404)
  }
  const health = await app.inject({ url: '/health' })
  assert.equal(health.statusCode, 200)
  assert.deepStrictEqual(health.json(), { status: 'ok' })
  assert.equal(app.hasDecorator('someSupport'), false)
})
