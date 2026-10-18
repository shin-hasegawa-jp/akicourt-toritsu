import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firestoreSettings } from '../src/storage/firestore/database'
import { parseFirestoreArguments } from '../src/storage/firestore-cli'

const local = { projectId: 'demo-akicourt-local', databaseId: '(default)' }

test('Firestore settings refuse accidental live access and production emulator use', () => {
  assert.throws(() => firestoreSettings(local, {}), /local-emulator-required/)
  assert.throws(
    () =>
      firestoreSettings(local, {
        FIRESTORE_EMULATOR_HOST: 'example.com:8080',
      }),
    /local-emulator-required/,
  )
  for (const host of ['firestore:0', 'localhost:65536', 'http://localhost:8080'])
    assert.throws(() => firestoreSettings(local, { FIRESTORE_EMULATOR_HOST: host }))
  const settings = firestoreSettings(local, { FIRESTORE_EMULATOR_HOST: 'firestore:8080' })
  assert.equal(settings.ssl, false)
  assert.equal(settings.host, 'firestore:8080')
  const production = { projectId: 'akicourt-prod', databaseId: '(default)' }
  assert.throws(() => firestoreSettings(production, {}))
  assert.throws(() =>
    firestoreSettings(production, {
      NODE_ENV: 'production',
      FIRESTORE_EMULATOR_HOST: '',
    }),
  )
  assert.throws(() => firestoreSettings(local, { NODE_ENV: 'production' }))
  assert.deepEqual(firestoreSettings(production, { NODE_ENV: 'production' }), production)
})

test('Firestore CLI requires explicit destination and defaults to dry-run', () => {
  const args = ['initialize', '--project', local.projectId, '--database', '(default)']
  assert.equal(parseFirestoreArguments(args).apply, false)
  assert.equal(parseFirestoreArguments(['repair-outbox', ...args.slice(1)]).apply, false)
  assert.equal(parseFirestoreArguments([...args, '--apply']).apply, true)
  for (const command of [
    'pause',
    'resume',
    'clear-block',
    'session-disable',
    'session-discard',
    'session-recover',
  ])
    assert.equal(parseFirestoreArguments([command, ...args.slice(1)]).apply, false)
  assert.equal(
    parseFirestoreArguments(['session-recover', ...args.slice(1), '--confirm-worker-stopped'])
      .confirmWorkerStopped,
    true,
  )
  for (const invalid of [
    ['initialize'],
    [...args, '--apply', '--apply'],
    [...args, '--project', 'other-project'],
    ['status', ...args.slice(1), '--apply'],
    [...args, '--unknown'],
    ['reset', ...args.slice(1)],
    ['resume', ...args.slice(1), '--confirm-worker-stopped'],
    ['session-recover', ...args.slice(1), '--confirm-worker-stopped', '--confirm-worker-stopped'],
  ])
    assert.throws(() => parseFirestoreArguments(invalid))
})
