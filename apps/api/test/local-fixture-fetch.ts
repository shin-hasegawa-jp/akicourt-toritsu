import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WeekResponse } from '../src/availability/response-schemas'
import { DateString, ParkId, parseValue } from '../src/validation'
import { offsetDate } from '../src/availability/parser'

// Saved weekly cells with shifted dates; home/facility HTML is synthetic.
// Never fall through to network access, even for an unsupported request.
export function fixtureFetch(): typeof fetch {
  const load = (name: 'grass-11' | 'hard') =>
    parseValue(
      WeekResponse,
      JSON.parse(
        readFileSync(join(process.cwd(), 'test/availability/fixtures', `${name}.json`), 'utf8'),
      ),
      () => new Error('invalid-local-fixture'),
    )
  const weeks = { grass: load('grass-11'), hard: load('hard') }
  return async (input, init) => {
    init?.signal?.throwIfAborted()
    const path = new URL(String(input)).pathname
    if (path === '/web/')
      return new Response('pawab2000', {
        headers: { 'set-cookie': 'local-fixture=1; Path=/web/; Secure' },
      })
    const fields = new URLSearchParams(String(init?.body ?? ''))
    if (path === '/web/rsvWOpeInstSrchVacantAction.do') {
      const park = parseValue(
        ParkId,
        fields.get('selectBldCd'),
        () => new Error('invalid-local-park'),
      )
      const suffix = fields.get('selectPpsCd') === '1030' ? '0020' : '0010'
      return new Response(
        `<input name="displayNo" value="prwrc2000"><input name="selectBldCd" value="${park}"><select id="facility-select"><option value="${park}${suffix}_3">Local fixture court</option></select>`,
      )
    }
    if (path === '/web/rsvWOpeInstSrchVacantAjaxAction.do') {
      const raw = fields.get('useDay') ?? ''
      const from = parseValue(
        DateString,
        `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        () => new Error('invalid-local-date'),
      )
      const week = structuredClone(weeks[fields.get('instCd')?.endsWith('0020') ? 'grass' : 'hard'])
      const day = (i: number) => Number(offsetDate(from, i).replaceAll('-', ''))
      week.weekDay.forEach((row, i) => {
        row.useDay = day(i)
      })
      week.result.forEach((row) =>
        row.timeResult.forEach((cell, i) => {
          cell.useDay = day(i)
        }),
      )
      // ASCII escapes survive the common client's Shift_JIS decoder.
      return new Response(
        JSON.stringify(week).replace(
          /[\u0080-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        ),
      )
    }
    throw new Error('unsupported-local-fixture-request')
  }
}
