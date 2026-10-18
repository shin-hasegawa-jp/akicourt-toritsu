import { test } from 'node:test'
import assert from 'node:assert/strict'
import { japanToday, scopes } from '../src/storage/scopes'

test('Japan date and canonical scopes', () => {
  assert.equal(japanToday(new Date('2026-10-09T15:00:00Z')), '2026-10-10')
  assert.deepEqual(
    scopes([{ parkId: '1280', surface: 'grass' }], '2026-10-10', '2026-10-16').map(
      (t) => t.startDate,
    ),
    ['2026-10-05', '2026-10-12'],
  )
  assert.throws(() => scopes([{ parkId: '1280', surface: 'grass' }], '2026-10-10', '2026-10-17'))
})

test('five targets expand into ten scopes; six targets are rejected', () => {
  const targets = Array.from({ length: 5 }, (_, i) => ({
    parkId: String(1000 + i),
    surface: 'grass' as const,
  }))
  assert.equal(scopes(targets, '2026-10-10', '2026-10-16').length, 10)
  assert.throws(() =>
    scopes([...targets, { parkId: '1005', surface: 'grass' }], '2026-10-10', '2026-10-16'),
  )
})
