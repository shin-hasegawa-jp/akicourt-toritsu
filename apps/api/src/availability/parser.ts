import { load } from 'cheerio'

export class AcquisitionError extends Error {
  constructor(public readonly kind: string) {
    super(kind)
  }
}
export type Slot = {
  date: string
  start: string
  end: string
  availableCourts: number
}
export type Week = { days: string[]; slots: Slot[]; checkedCells: number }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (): never => {
  throw new AcquisitionError('invalid-response')
}
export function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail()
  const date = new Date(`${value}T00:00:00Z`)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    return fail()
  return value
}
export function offsetDate(value: string, days: number): string {
  const date = new Date(`${validateDate(value)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function day(value: unknown): string {
  const text = String(value)
  if (!/^\d{8}$/.test(text)) return fail()
  return validateDate(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
  )
}
function time(value: unknown): string {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2359 ||
    value % 100 > 59
  )
    return fail()
  const text = String(value).padStart(4, '0')
  return `${text.slice(0, 2)}:${text.slice(2)}`
}
export function parseJSON(text: string): unknown {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AcquisitionError('non-json-response')
  }
  if (record(data) && 'ErrManager' in data)
    throw new AcquisitionError('official-error')
  return data
}
export function parseParks(text: string): Array<{ id: string; name: string }> {
  const data = parseJSON(text)
  if (
    !record(data) ||
    !Array.isArray(data.results) ||
    data.all !== data.results.length ||
    !data.results.length
  )
    return fail()
  return data.results.map((row: unknown) => {
    if (
      !record(row) ||
      typeof row.bcd !== 'string' ||
      !/^\d+$/.test(row.bcd) ||
      typeof row.bcdNm !== 'string' ||
      !row.bcdNm
    )
      return fail()
    return { id: row.bcd, name: row.bcdNm }
  })
}
export function parseFacilities(
  html: string,
  parkId: string
): Array<{ id: string; name: string }> {
  const $ = load(html)
  if (
    $('input[name="displayNo"]').val() !== 'prwrc2000' ||
    $('input[name="selectBldCd"]').val() !== parkId
  )
    return fail()
  const rows: Array<{ id: string; name: string }> = []
  $('#facility-select option').each((_, element) => {
    const id = ($(element).attr('value') || '').split('_')[0]!
    if (id === '0') return
    if (!/^\d+$/.test(id) || !$(element).text().trim()) return fail()
    rows.push({ id, name: $(element).text().trim() })
  })
  if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length)
    return fail()
  return rows
}
export function parseWeek(text: string, startDate: string): Week {
  const data = parseJSON(text)
  if (
    !record(data) ||
    data.dayNum !== 7 ||
    data.lendType !== 3 ||
    !Array.isArray(data.weekDay) ||
    data.weekDay.length !== 7 ||
    !Array.isArray(data.result) ||
    !data.result.length
  )
    return fail()
  const days = data.weekDay.map((row: unknown, index: number) => {
    if (!record(row) || day(row.useDay) !== offsetDate(startDate, index))
      return fail()
    return day(row.useDay)
  })
  const slots: Slot[] = []
  const keys = new Set<string>()
  const zones = new Set<number>()
  let checkedCells = 0
  for (const row of data.result) {
    if (
      !record(row) ||
      typeof row.tzoneNo !== 'number' ||
      !Number.isInteger(row.tzoneNo) ||
      zones.has(row.tzoneNo) ||
      !Array.isArray(row.timeResult) ||
      row.timeResult.length !== 7
    )
      return fail()
    zones.add(row.tzoneNo)
    const seenDays = new Set<string>()
    for (const cell of row.timeResult) {
      if (!record(cell)) return fail()
      const date = day(cell.useDay)
      const start = time(cell.startTime)
      const end = time(cell.endTime)
      if (
        !days.includes(date) ||
        seenDays.has(date) ||
        start >= end ||
        typeof cell.rsvNum !== 'number' ||
        !Number.isInteger(cell.rsvNum) ||
        cell.rsvNum < 0 ||
        cell.selectNum !== 0
      )
        return fail()
      seenDays.add(date)
      const key = `${date}/${start}/${end}`
      if (keys.has(key)) return fail()
      keys.add(key)
      // Confirmed closed cells: 1 is maintenance, 700 is outside reception.
      // Both are valid weekly data, never available slots.
      if (cell.status !== 0 && cell.status !== 1 && cell.status !== 210 && cell.status !== 700)
        throw new AcquisitionError('unknown-status')
      if (
        (cell.status === 0 && (cell.alt !== '空き' || cell.rsvNum < 1)) ||
        (cell.status === 1 && (cell.alt !== '保守日' || cell.rsvNum !== 0)) ||
        (cell.status === 210 && (cell.alt !== '予約あり' || cell.rsvNum !== 0)) ||
        (cell.status === 700 && (cell.alt !== '受付期間外' || cell.rsvNum !== 0))
      )
        return fail()
      if (cell.status === 0)
        slots.push({ date, start, end, availableCourts: cell.rsvNum })
      checkedCells++
    }
  }
  return {
    days,
    slots: slots.sort((a, b) =>
      `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)
    ),
    checkedCells
  }
}
