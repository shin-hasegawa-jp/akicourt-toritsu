import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import routes from '../src/routes/availability'
import parks from '../src/storage/park-options'

test('public park choices use the deployment catalog and its order without storage or HTTP', async () => {
  const previous = process.env.DATABASE_URL
  const fetch = globalThis.fetch
  delete process.env.DATABASE_URL
  globalThis.fetch = async () => {
    throw new Error('official HTTP must not be used')
  }
  const app = Fastify()
  try {
    await app.register(routes, { prefix: '/availability' })
    const response = await app.inject('/availability/parks')
    assert.equal(response.statusCode, 200)
    const catalog = response.json()
    assert.equal(catalog.defaultTarget, '1280:grass')
    assert.deepEqual(
      catalog.groups.map((group: { surface: string }) => group.surface),
      ['hard', 'grass'],
    )
    assert.deepEqual(
      catalog.groups.flatMap(
        (group: { surface: string; parks: { parkId: string; parkName: string }[] }) =>
          group.parks.map((park) => ({
            parkId: park.parkId,
            surface: group.surface,
            name: park.parkName,
          })),
      ),
      parks,
    )
  } finally {
    await app.close()
    globalThis.fetch = fetch
    if (previous !== undefined) process.env.DATABASE_URL = previous
  }
})
