import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import routes from '../src/routes/availability'
test('API schemas reject invalid input; missing storage returns safe 503', async () => {
  const app = Fastify()
  const previous = process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.GOOGLE_CLOUD_PROJECT
  try {
    await app.register(routes, { prefix: '/availability' })
    assert.equal((await app.inject('/availability/parks')).statusCode, 503)
    const request = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/availability/search', payload: payload as object })
    for (const payload of [
      {},
      { targets: [] },
      { targets: [{ parkId: '1280', surface: 'grass', extra: 1 }] },
      {
        targets: [{ parkId: '1280', surface: 'grass' }],
        dateFrom: '2026-02-30',
        dateTo: '2026-03-01',
      },
      { targets: [{ parkId: '1280', surface: 'grass' }], weekdays: [] },
      { targets: [{ parkId: '1280', surface: 'grass' }], timeFrom: '24:00' },
      { targets: [{ parkId: '1280', surface: 'grass' }], minDurationMinutes: '30' },
      { targets: [{ parkId: '1280', surface: 'grass' }], includeHolidays: 'false' },
      { targets: [{ parkId: '1280', surface: 'grass' }], dateFom: '2026-10-10' },
    ]) {
      const response = await request(payload)
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, 'invalid_request')
    }
    const targets = Array.from({ length: 5 }, (_, i) => ({
      parkId: String(1000 + i),
      surface: 'grass',
    }))
    assert.equal((await request({ targets })).statusCode, 503)
    assert.equal(
      (await request({ targets: [...targets, { parkId: '1005', surface: 'grass' }] })).statusCode,
      400,
    )
    assert.equal(
      (await request({ targets: [{ parkId: '1280', surface: 'grass' }] })).statusCode,
      503,
    )
    assert.equal((await app.inject('/availability/updates/not-a-uuid')).statusCode, 400)
  } finally {
    await app.close()
    if (previous !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previous
  }
})
