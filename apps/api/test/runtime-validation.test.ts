import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AcquisitionSession } from '../src/availability/client'
import { AcquisitionError, parseParks, parseWeek } from '../src/availability/parser'
import { serializeSession, restoreSession } from '../src/availability/session-state'
import { encodeSnapshot, verifySnapshot } from '../src/storage/firestore/snapshot-codec'
import { resolveInput } from '../src/availability-api/input'
import { syntheticResult } from './firestore-fixtures'

const target = { parkId: '1280', surface: 'grass' as const, startDate: '2026-10-12' }
test('unknown and malformed nested session data fail with a safe domain error', () => {
  const valid = serializeSession(new AcquisitionSession())
  for (const input of [
    null,
    [],
    'secret',
    { ...valid, initialized: 'false' },
    { ...valid, cookieJar: { ...valid.cookieJar, cookies: [null] } },
    { ...valid, targets: [{ key: '1280/grass', parkName: 'park', facilities: [null] }] },
  ])
    assert.throws(
      () => restoreSession(input),
      (error) =>
        error instanceof AcquisitionError &&
        error.kind === 'session-recovery-required' &&
        !error.message.includes('secret'),
    )
})

test('cookie SDK attributes survive schema parsing without stripping domain/path/expiry', () => {
  const state = new AcquisitionSession()
  state.jar.setCookieSync(
    'SESSION=private; Secure; HttpOnly; SameSite=Lax; Path=/web/; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
    'https://kouen.sports.metro.tokyo.lg.jp/web/',
  )
  state.initialized = true
  const saved = serializeSession(state)
  const restored = restoreSession(saved)
  const attributes = (cookies: typeof saved.cookieJar.cookies) =>
    cookies.map(({ lastAccessed: _lastAccessed, ...cookie }) => cookie)
  assert.deepEqual(
    attributes(serializeSession(restored).cookieJar.cookies),
    attributes(saved.cookieJar.cookies),
  )
  assert.equal(
    restored.jar.getCookieStringSync('https://kouen.sports.metro.tokyo.lg.jp/other/'),
    '',
  )
})

test('snapshot boundary rejects wrong scalar types and malformed nested data without coercion', () => {
  const snapshot = encodeSnapshot(syntheticResult(target, 1))
  for (const input of [
    null,
    [],
    { ...snapshot, slotCount: '1' },
    { ...snapshot, facilities: [null] },
    { ...snapshot, target: null },
    { ...snapshot, payload: [{ ...snapshot.payload[0], availableCourts: '1' }] },
  ])
    assert.throws(() => verifySnapshot(input, target), /invalid-snapshot/)
})

test('official response extensions remain accepted while unknown statuses remain failures', () => {
  assert.deepEqual(
    parseParks(
      JSON.stringify({
        all: 1,
        extension: true,
        results: [{ bcd: '1280', bcdNm: '公園', future: null }],
      }),
    ),
    [{ id: '1280', name: '公園' }],
  )
  const raw = JSON.parse(
    readFileSync(join(__dirname, 'availability/fixtures/grass-11.json'), 'utf8'),
  )
  raw.extension = { future: true }
  assert.equal(parseWeek(JSON.stringify(raw), '2026-10-10').slots.length, 15)
  raw.result[0].timeResult[0].status = 999
  assert.throws(
    () => parseWeek(JSON.stringify(raw), '2026-10-10'),
    (e) => e instanceof AcquisitionError && e.kind === 'unknown-status',
  )
})

test('direct API service callers receive the same strict shape validation as HTTP callers', () => {
  const valid = { targets: [{ parkId: '1280', surface: 'grass' as const }] }
  for (const patch of [
    { includeHolidays: 'false' },
    { weekdays: ['1'] },
    { minDurationMinutes: '30' },
    { typo: true },
  ])
    assert.throws(() => resolveInput({ ...valid, ...patch }), /対象・期間/)
})
