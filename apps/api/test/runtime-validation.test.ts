import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AcquisitionSession } from '../src/availability/client'
import { AcquisitionError, parseParks, parseWeek } from '../src/availability/parser'
import {
  serializeSession,
  restoreSession,
  parseSessionState,
} from '../src/availability/session-state'

test('session parsing never exposes cookie input in a domain error', () => {
  const valid = serializeSession(new AcquisitionSession())
  const input = {
    ...valid,
    cookieJar: {
      ...valid.cookieJar,
      cookies: [{ key: 'SESSION', value: { private: 'cookie-secret' } }],
    },
  }
  assert.throws(
    () => parseSessionState(input),
    (error) =>
      error instanceof AcquisitionError &&
      error.kind === 'session-recovery-required' &&
      !JSON.stringify(error).includes('cookie-secret') &&
      !error.message.includes('cookie-secret'),
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

test('official response extensions remain accepted', () => {
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
})
