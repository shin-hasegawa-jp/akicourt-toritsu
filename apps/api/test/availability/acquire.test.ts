import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquire, AcquisitionSession, Target } from '../../src/availability/client'
import {
  parseFacilities,
  parseWeek,
  validateDate
} from '../../src/availability/parser'

// Fixtures: anonymous public weekly JSON captured on 2026-10-10; no cookies or credentials.
const fixture = (name = 'grass-11'): string =>
  readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')
const wire = (data: unknown): Response =>
  new Response(
    JSON.stringify(data).replace(
      /[^\x00-\x7f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
  )
const target: Target = {
  parkId: '1280',
  surface: 'grass',
  startDate: '2026-10-10'
}
const html =
  '<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="1280"><select id="facility-select"><option value="0">choose</option><option value="12800020_3">Tennis</option></select>'
const options = { sleep: async () => {}, intervalMs: 0 }

test('saved responses preserve dates, times and court counts', () => {
  const grass = parseWeek(fixture(), target.startDate)
  assert.equal(grass.checkedCells, 28)
  assert.equal(grass.slots.length, 15)
  assert.deepEqual(grass.slots[0], {
    date: '2026-10-13',
    start: '09:00',
    end: '11:00',
    availableCourts: 4
  })
  assert.equal(parseWeek(fixture('hard'), target.startDate).checkedCells, 42)
})

test('maintenance cells preserve the available slots in the rest of the official week', () => {
  const data = JSON.parse(fixture('ariake-hard-19'))
  const week = parseWeek(JSON.stringify(data), '2026-10-19')
  assert.equal(week.checkedCells, 49)
  assert.equal(week.slots.length, 5)
  assert.deepEqual(week.slots[0], { date: '2026-10-19', start: '09:00', end: '11:00', availableCourts: 5 })
  assert.ok(week.slots.every((slot) => slot.start !== '07:00'))
  for (const change of [{ alt: '空き' }, { rsvNum: 1 }, { status: '1' }, { status: 2 }]) {
    const bad = structuredClone(data)
    Object.assign(bad.result[0].timeResult[0], change)
    assert.throws(() => parseWeek(JSON.stringify(bad), '2026-10-19'))
  }
  data.result[0].timeResult.pop()
  assert.throws(() => parseWeek(JSON.stringify(data), '2026-10-19'))
})

test('only a complete validated week can mean no availability', () => {
  const data = JSON.parse(fixture())
  for (const row of data.result)
    for (const cell of row.timeResult)
      Object.assign(cell, { status: 210, alt: '予約あり', rsvNum: 0 })
  assert.deepEqual(parseWeek(JSON.stringify(data), target.startDate).slots, [])
  data.result[0].timeResult.pop()
  assert.throws(() => parseWeek(JSON.stringify(data), target.startDate))
})

test('closed days preserve other slots and require an exact label and zero courts', () => {
  const data = JSON.parse(fixture())
  const expected = parseWeek(fixture(), target.startDate)
  // The observed official response uses status=2 / alt=休館日 / rsvNum=0.
  for (const row of data.result)
    Object.assign(row.timeResult[0], { status: 2, alt: '休館日', rsvNum: 0 })
  const week = parseWeek(JSON.stringify(data), target.startDate)
  assert.equal(week.checkedCells, expected.checkedCells)
  assert.deepEqual(week.slots, expected.slots.filter((slot) => slot.date !== target.startDate))
  for (const change of [{ alt: '空き' }, { alt: '保守日' }, { rsvNum: 1 }, { status: '2' }, { status: 3 }]) {
    const bad = structuredClone(data)
    Object.assign(bad.result[0].timeResult[0], change)
    assert.throws(() => parseWeek(JSON.stringify(bad), target.startDate))
  }
  for (const row of data.result)
    for (const cell of row.timeResult)
      Object.assign(cell, { status: 2, alt: '休館日', rsvNum: 0 })
  assert.deepEqual(parseWeek(JSON.stringify(data), target.startDate).slots, [])
  data.result[0].timeResult.pop()
  assert.throws(() => parseWeek(JSON.stringify(data), target.startDate))
})

test('elapsed dates outside reception do not invalidate a complete canonical week', () => {
  const data = JSON.parse(fixture('grass-past'))
  const week = parseWeek(JSON.stringify(data), '2026-10-05')
  assert.equal(week.checkedCells, 28)
  assert.deepEqual(
    week.days,
    Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 5).padStart(2, '0')}`)
  )
  assert.deepEqual(week.slots, [])
  // A synthetic available current-day cell must still be emitted among elapsed days.
  Object.assign(data.result[0].timeResult[5], { status: 0, alt: '空き', rsvNum: 2 })
  assert.deepEqual(parseWeek(JSON.stringify(data), '2026-10-05').slots, [
    { date: '2026-10-10', start: '09:00', end: '11:00', availableCourts: 2 }
  ])
})

test('outside reception requires its exact label and zero court count; unknown states still fail', () => {
  for (const values of [
    { status: 700, alt: '空き', rsvNum: 0 },
    { status: 700, alt: '受付期間外', rsvNum: 1 },
    { status: 701, alt: '受付期間外', rsvNum: 0 },
    { status: '700', alt: '受付期間外', rsvNum: 0 },
  ]) {
    const data = JSON.parse(fixture('grass-past'))
    Object.assign(data.result[0].timeResult[0], values)
    assert.throws(() => parseWeek(JSON.stringify(data), '2026-10-05'))
  }
  const missing = JSON.parse(fixture('grass-past'))
  missing.result[0].timeResult.pop()
  assert.throws(() => parseWeek(JSON.stringify(missing), '2026-10-05'))
})

test('HTML, official errors, unknown statuses, duplicates and wrong dates fail', () => {
  assert.throws(() => parseWeek('<html>error</html>', target.startDate))
  assert.throws(() => parseWeek('{"ErrManager":{}}', target.startDate))
  const data = JSON.parse(fixture())
  data.result[0].timeResult[0].status = 999
  assert.throws(() => parseWeek(JSON.stringify(data), target.startDate))
  assert.throws(() => parseWeek(fixture(), '2026-10-11'))
  assert.throws(() => validateDate('2026-02-30'))
  const duplicate = JSON.parse(fixture())
  duplicate.result[0].timeResult[1] = duplicate.result[0].timeResult[0]
  assert.throws(() => parseWeek(JSON.stringify(duplicate), target.startDate))
})

test('HTML requires matching screen and park; hidden no-results text is harmless', () => {
  assert.deepEqual(
    parseFacilities(html + '<div>空き施設が見つかりませんでした</div>', '1280'),
    [{ id: '12800020', name: 'Tennis' }]
  )
  assert.throws(() => parseFacilities(html, '1310'))
  assert.throws(() => parseFacilities('<html>Error</html>', '1280'))
})

test('retain session cookies, send documented fields, and do not log cookies', async () => {
  let call = 0
  const fetchImpl: typeof fetch = async (_url, init) => {
    call++
    if (call === 1)
      return new Response('pawab2000', {
        headers: { 'set-cookie': 'session=fake-test-only; Path=/web/; Secure' }
      })
    assert.match(
      new Headers(init?.headers).get('cookie') || '',
      /session=fake-test-only/
    )
    assert.equal(init?.redirect, 'manual')
    if (call === 2)
      return wire({ all: 1, results: [{ bcd: '1280', bcdNm: 'Test park' }] })
    if (call === 3) return new Response(html)
    assert.match(String(init?.body), /transVacantMode=11/)
    return wire(JSON.parse(fixture()))
  }
  const [result] = await acquire([target], { ...options, fetchImpl })
  assert.equal(result?.state, 'success')
  assert.equal(call, 4)
  assert.equal(JSON.stringify(result).includes('fake-test-only'), false)
})

test('a failed target is distinct and the next target can succeed', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls++
    if (calls === 1 || calls === 3) return new Response('pawab2000')
    if (calls === 2) return new Response('<html>error</html>')
    if (calls === 4)
      return wire({ all: 1, results: [{ bcd: '1280', bcdNm: 'Test' }] })
    if (calls === 5) return new Response(html)
    return wire(JSON.parse(fixture()))
  }
  const results = await acquire([target, target], { ...options, fetchImpl })
  assert.equal(results[0]?.state, 'failed')
  assert.equal('facilities' in results[0]!, false)
  assert.equal(results[1]?.state, 'success')
})

test('retry server errors once; never retry forbidden or redirects', async () => {
  for (const status of [503, 403, 302]) {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      return new Response('', { status })
    }
    const [result] = await acquire([target], { ...options, fetchImpl })
    assert.equal(result?.state, 'failed')
    assert.equal(calls, status === 503 ? 2 : 1)
  }
})

test('timeout includes response body and retries are bounded', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls++
    const response = new Response('')
    Object.defineProperty(response, 'arrayBuffer', {
      value: async () =>
        await new Promise<ArrayBuffer>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          )
        })
    })
    return response
  }
  const [result] = await acquire([target], {
    ...options,
    fetchImpl,
    timeoutMs: 5
  })
  assert.equal(result?.state, 'failed')
  if (result?.state === 'failed') assert.equal(result.error, 'timeout')
  assert.equal(calls, 2)
})


test('reusable session keeps cookies and facility IDs across jobs with per-job metrics', async () => {
  const session = new AcquisitionSession()
  const paths: string[] = []
  let activePark = '1280'
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    const fields = new URLSearchParams(String(init?.body || ''))
    if (path === '/web/') return new Response('pawab2000', { headers: { 'set-cookie': 'session=test; Path=/web/; Secure' } })
    assert.match(new Headers(init?.headers).get('cookie') || '', /session=test/)
    if (path.includes('Favorite2')) return wire({ all: 2, results: [{ bcd: '1280', bcdNm: 'Grass' }, { bcd: '1310', bcdNm: 'Hard' }] })
    if (path.endsWith('InstSrchVacantAction.do')) {
      activePark = fields.get('selectBldCd')!
      return new Response(html.replaceAll('1280', activePark))
    }
    const data = JSON.parse(fixture())
    const date = Number(fields.get('useDay'))
    const delta = date === 20261017 ? 7 : 0
    for (const row of data.weekDay) row.useDay += delta
    for (const row of data.result) for (const cell of row.timeResult) cell.useDay += delta
    return wire(data)
  }
  const opts = { ...options, session, fetchImpl }
  const [first] = await acquire([target], opts)
  const [next] = await acquire([{ ...target, startDate: '2026-10-17' }], opts)
  const [other] = await acquire([{ ...target, parkId: '1310', surface: 'hard' }], opts)
  assert.equal(first?.state, 'success')
  assert.equal(next?.state, 'success')
  assert.equal(other?.state, 'success')
  assert.deepEqual([first?.requests.length, next?.requests.length, other?.requests.length], [4, 1, 3])
  assert.equal(paths.filter(p => p === '/web/').length, 1)
  assert.equal(paths.length, 8)
})

test('failed initialization is throttled; acquisition errors do not imply session expiry', async () => {
  const session = new AcquisitionSession()
  let calls = 0
  const opts = { ...options, session, fetchImpl: async () => { calls++; return new Response('<html>unavailable</html>') } }
  assert.equal((await acquire([target], opts))[0]?.state, 'failed')
  assert.equal((await acquire([target], opts))[0]?.requests.length, 0)
  assert.equal(calls, 1)
  session.initializationRetryAt = 0
  await acquire([target], opts)
  assert.equal(calls, 2)
  session.initialized = true
  session.targets.set('1280/grass', { parkName: 'Test', facilities: [{ id: '12800020', name: 'Grass' }] })
  const [result] = await acquire([target], opts)
  assert.equal(result?.state, 'failed')
  assert.equal(result?.requests.length, 1)
  assert.ok(result?.requests[0]?.path.endsWith('InstSrchVacantAjaxAction.do'))
  assert.equal(session.initialized, true)
})
