import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDeliverySettings } from '../src/local/settings'

const environment = {
  GOOGLE_CLOUD_PROJECT: 'demo-akicourt-local',
  FIRESTORE_DATABASE_ID: '(default)',
  FIRESTORE_EMULATOR_HOST: 'firestore:8080',
  LOCAL_WORKER_URL: 'http://worker:3000',
}
test('local delivery requires an internal destination and emulator; production cannot enable it', () => {
  assert.equal(localDeliverySettings(environment), environment.LOCAL_WORKER_URL)
  for (const changes of [
    { NODE_ENV: 'production' },
    { LOCAL_WORKER_URL: undefined },
    { GOOGLE_CLOUD_PROJECT: 'real-project' },
    { FIRESTORE_EMULATOR_HOST: undefined },
    { LOCAL_WORKER_URL: 'https://example.com' },
  ])
    assert.throws(() => localDeliverySettings({ ...environment, ...changes }))
})
