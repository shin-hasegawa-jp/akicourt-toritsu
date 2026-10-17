import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Target } from '../src/availability/client'
import { syntheticResult } from './firestore-fixtures'
import {
  encodeSnapshot,
  jsonBytes,
  limits,
  measureDocument,
  verifyChunks,
} from '../src/storage/firestore/snapshot-codec'

const target: Target = { parkId: '1280', surface: 'grass', startDate: '2026-10-12' }

test('snapshot chunks split before 256KiB and detect missing or changed content', () => {
  const { manifest, chunks } = encodeSnapshot(syntheticResult(target, 6000))
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((c) => jsonBytes(c.payload) <= limits.chunkBytes))
  assert.equal(verifyChunks(manifest, chunks).length, 6000)
  const reordered = chunks.map((c) => ({
    ...c,
    payload: c.payload.map((row) => Object.fromEntries(Object.entries(row).reverse())),
  }))
  assert.equal(verifyChunks(manifest, reordered).length, 6000)
  assert.throws(() => verifyChunks(manifest, chunks.slice(1)))
  const broken = structuredClone(chunks)
  broken[0].payload[0].availableCourts++
  assert.throws(() => verifyChunks(manifest, broken))
})

test('snapshot storage size follows Firestore formula; protobuf size is measured separately', () => {
  // The official storage-size example is 147 bytes.
  const measured = measureDocument(
    'projects/demo-akicourt-local/databases/(default)/documents/users/jeff/tasks/my_task_id',
    {
      type: 'Personal',
      done: false,
      priority: 1,
      description: 'Learn Cloud Firestore',
    },
  )
  assert.equal(measured.documentBytes, 147)
  assert.ok(measured.wireBytes > 0)
  assert.notEqual(measured.documentBytes, measured.wireBytes)
  const ascii = measureDocument('projects/demo-akicourt-local/databases/(default)/documents/a/b', {
    name: 'aaa',
  })
  const japanese = measureDocument(
    'projects/demo-akicourt-local/databases/(default)/documents/a/b',
    { name: 'あああ' },
  )
  assert.equal(japanese.documentBytes - ascii.documentBytes, 6)
  assert.equal(japanese.wireBytes - ascii.wireBytes, 6)
})

test('snapshots reject partial weeks, duplicate slots and scopes outside Monday', () => {
  const incomplete = syntheticResult(target, 1)
  incomplete.facilities[0].week.days.pop()
  assert.throws(() => encodeSnapshot(incomplete))
  const duplicate = syntheticResult(target, 1)
  duplicate.facilities[0].week.slots.push(duplicate.facilities[0].week.slots[0])
  assert.throws(() => encodeSnapshot(duplicate))
  assert.throws(() => encodeSnapshot(syntheticResult({ ...target, startDate: '2026-10-13' }, 0)))
})
