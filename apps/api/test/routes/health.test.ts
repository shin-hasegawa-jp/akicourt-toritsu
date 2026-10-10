import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { build } from '../helper'

test('health responds without external dependencies', async (t) => {
  const app = await build(t)
  const response = await app.inject({ url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})
