import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AcquisitionSession } from '../src/availability/client'
import {
  restoreSession,
  serializeSession,
  parseSessionState,
} from '../src/availability/session-state'

test('session DTO restores cookies and prepared facilities as one independent state', () => {
  const state = new AcquisitionSession()
  state.jar.setCookieSync(
    'SESSION=private; Path=/; Secure',
    'https://kouen.sports.metro.tokyo.lg.jp',
  )
  state.initialized = true
  state.prepared.add('1280/grass')
  state.targets.set('1280/grass', {
    parkName: '公園',
    facilities: [{ id: '12800020', name: 'テニス' }],
  })
  const restored = restoreSession(
    parseSessionState(JSON.parse(JSON.stringify(serializeSession(state)))),
  )
  assert.equal(
    restored.jar.getCookieStringSync('https://kouen.sports.metro.tokyo.lg.jp/web/'),
    'SESSION=private',
  )
  assert.deepEqual([...restored.prepared], ['1280/grass'])
  assert.deepEqual([...restored.targets], [...state.targets])
  restored.prepared.clear()
  assert.equal(state.prepared.size, 1)
})

test('empty state is accepted; incompatible, expired and contradictory DTOs require recovery', () => {
  const empty = serializeSession(new AcquisitionSession())
  assert.equal(restoreSession(empty).initialized, false)
  for (const value of [
    { ...empty, initialized: true },
    { ...empty, prepared: ['1280/grass'] },
    { ...empty, cookieJar: { ...empty.cookieJar, version: 'unknown-version' } },
  ])
    assert.throws(() => restoreSession(value), /session-recovery-required/)
  const expired = new AcquisitionSession()
  expired.jar.setCookieSync(
    'SESSION=expired; Max-Age=1; Path=/',
    'https://kouen.sports.metro.tokyo.lg.jp',
  )
  expired.initialized = true
  assert.throws(
    () => restoreSession(serializeSession(expired), new Date(Date.now() + 2000)),
    /session-recovery-required/,
  )
})
