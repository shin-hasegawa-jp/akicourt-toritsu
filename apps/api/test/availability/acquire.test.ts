import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquire, Target } from '../../src/availability/client'
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


test('outside-hours placeholders preserve the rest of the week and reject contradictions', () => {
  const data = JSON.parse(fixture())
  const original = parseWeek(fixture(), target.startDate)
  const removed = data.result[0].timeResult[3]
  Object.assign(removed, { status: 600, alt: '時間外', startTime: -1, endTime: -1, rsvNum: 0 })
  const week = parseWeek(JSON.stringify(data), target.startDate)
  assert.equal(week.checkedCells, original.checkedCells)
  assert.deepEqual(week.slots, original.slots.filter(s => !(s.date === '2026-10-13' && s.start === '09:00')))
  for (const change of [{ alt: '空き' }, { rsvNum: 1 }, { selectNum: 1 }, { startTime: 900 }, { endTime: 1100 }, { status: '600' }, { useDay: 20261101 }]) {
    const bad = structuredClone(data)
    Object.assign(bad.result[0].timeResult[3], change)
    assert.throws(() => parseWeek(JSON.stringify(bad), target.startDate))
  }
  data.result[0].timeResult[4] = structuredClone(removed)
  assert.throws(() => parseWeek(JSON.stringify(data), target.startDate))
})
