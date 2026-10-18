import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquire, AcquisitionSession } from '../src/availability/client'
import { fixtureFetch } from '../src/local/fixture-fetch'
import { localSettings } from '../src/local/settings'

const environment = {
  GOOGLE_CLOUD_PROJECT: 'demo-akicourt-local',
  FIRESTORE_DATABASE_ID: '(default)',
  FIRESTORE_EMULATOR_HOST: 'firestore:8080',
  LOCAL_ACQUISITION: 'fixture',
}
test('local acquisition requires explicit mode and emulator; production cannot enable it', () => {
  assert.equal(localSettings(environment).mode, 'fixture')
  for (const changes of [
    { NODE_ENV: 'production' },
    { LOCAL_ACQUISITION: undefined },
    { GOOGLE_CLOUD_PROJECT: 'real-project' },
    { FIRESTORE_EMULATOR_HOST: undefined },
    { LOCAL_WORKER_URL: 'https://example.com' },
  ])
    assert.throws(() => localSettings({ ...environment, ...changes }))
})

test('saved weekly cells shift to requested weeks for both surfaces and reuse prepared sessions', async () => {
  const session = new AcquisitionSession()
  const fetchImpl = fixtureFetch()
  const options = { session, fetchImpl, sleep: async () => {}, intervalMs: 0 }
  for (const surface of ['grass', 'hard'] as const) {
    const [first] = await acquire([{ parkId: '1280', surface, startDate: '2026-10-19' }], options)
    assert.equal(first.state, 'success')
    assert.equal(first.facilities[0].week.days[0], '2026-10-19')
    assert.ok(first.facilities[0].week.slots.length > 0)
    const [second] = await acquire([{ parkId: '1280', surface, startDate: '2026-10-26' }], options)
    assert.equal(second.state, 'success')
    assert.equal(second.requests.length, 1)
    if (second.state === 'success') assert.equal(second.facilities[0].week.days[0], '2026-10-26')
  }
  await assert.rejects(fetchImpl('https://example.com/unsupported'))
})
