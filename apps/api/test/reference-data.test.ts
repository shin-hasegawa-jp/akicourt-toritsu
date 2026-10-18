import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import parks from '../src/storage/park-options'

test('deployment park catalog matches the reviewed official options', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'availability/fixtures/official-parks.json'), 'utf8'),
  )
  assert.deepEqual(
    parks,
    Object.entries({ hard: fixture.hard, grass: fixture.grass }).flatMap(([surface, rows]) =>
      (rows as { id: string; name: string }[]).map(({ id, name }) => ({
        parkId: id,
        surface,
        name,
      })),
    ),
  )
})
