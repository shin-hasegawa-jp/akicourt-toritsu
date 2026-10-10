export const parks = [
  {
    key: '1280:grass',
    parkId: '1280',
    parkName: '東大和南公園',
    surface: 'grass' as const,
    label: '人工芝',
  },
  {
    key: '1310:hard',
    parkId: '1310',
    parkName: '大井ふ頭海浜公園Ａ',
    surface: 'hard' as const,
    label: 'ハード',
  },
]
export const weekdayNames = ['日', '月', '火', '水', '木', '金', '土']
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
export function offset(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export type Conditions = {
  targets: string[]
  dateFrom: string
  dateTo: string
  weekdays: number[]
  includeHolidays: boolean
  timeFrom: string
  timeTo: string
  minDurationMinutes: number
}
export function defaults(): Conditions {
  const dateFrom = today()
  return {
    targets: [parks[0]!.key],
    dateFrom,
    dateTo: offset(dateFrom, 6),
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    includeHolidays: false,
    timeFrom: '00:00',
    timeTo: '24:00',
    minDurationMinutes: 0,
  }
}
export function validate(input: Conditions): string | null {
  const validDate = (date: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    offset(date, 0) === date
  if (
    !input.targets.length ||
    input.targets.length > 2 ||
    input.targets.some((key) => !parks.some((p) => p.key === key))
  )
    return '公園・種目を1〜2件選んでください。'
  if (
    !validDate(input.dateFrom) ||
    !validDate(input.dateTo) ||
    input.dateFrom > input.dateTo ||
    input.dateTo > offset(input.dateFrom, 6)
  )
    return '開始日と終了日を含め、最大7日間の期間を指定してください。'
  if (!input.weekdays.length && !input.includeHolidays)
    return '曜日を選ぶか、祝日を含めてください。'
  if (input.timeFrom >= input.timeTo) return '終了時刻は開始時刻より後にしてください。'
  return null
}
export type Scenario = 'success' | 'empty' | 'none' | 'partial' | 'failed' | 'queued'
export type Scope = {
  parkId: string
  surface: 'grass' | 'hard'
  weekStart: string
  dataState: 'fresh' | 'stale' | 'unavailable'
  snapshotId: string | null
  lastSuccessAt: string | null
  latestAttempt: {
    jobId: string
    state: 'queued' | 'running' | 'succeeded' | 'failed'
    errorCode: string | null
  } | null
}
export type Slot = {
  parkId: string
  parkName: string
  surface: 'grass' | 'hard'
  facilityId: string
  facilityName: string
  date: string
  start: string
  end: string
  availableCourts: number
  snapshotId: string
  observedAt: string
}
export type SearchResult = {
  generatedAt: string
  dateFrom: string
  dateTo: string
  coverage: 'complete' | 'partial' | 'none'
  scopes: Scope[]
  slots: Slot[]
  officialUrl: string
}
export function minute(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h! * 60 + m!
}
// Synthetic data only. No fetch, storage read or official availability is involved.
export function preview(input: Conditions, scenario: Scenario): SearchResult {
  const generatedAt = new Date().toISOString()
  const observedAt = new Date(Date.now() - (scenario === 'failed' ? 3600000 : 120000)).toISOString()
  const monday = (date: string) =>
    offset(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7))
  const weeks = [...new Set([monday(input.dateFrom), monday(input.dateTo)])]
  const selected = parks.filter((p) => input.targets.includes(p.key))
  const scopes: Scope[] = selected.flatMap((park) =>
    weeks.map((weekStart) => ({
      parkId: park.parkId,
      surface: park.surface,
      weekStart,
      dataState: 'fresh',
      snapshotId: `demo-${park.key}-${weekStart}`,
      lastSuccessAt: observedAt,
      latestAttempt: {
        jobId: `demo-job-${park.key}-${weekStart}`,
        state: 'succeeded',
        errorCode: null,
      },
    })),
  )
  scopes.forEach((scope, index) => {
    if (
      scenario === 'none' ||
      scenario === 'queued' ||
      (scenario === 'partial' && index === scopes.length - 1)
    ) {
      scope.snapshotId = null
      scope.lastSuccessAt = null
      scope.dataState = 'unavailable'
      scope.latestAttempt =
        scenario === 'queued'
          ? { jobId: 'demo-queued', state: 'running', errorCode: null }
          : scenario === 'partial'
            ? { jobId: 'demo-failed', state: 'failed', errorCode: 'timeout' }
            : null
    } else if (scenario === 'failed') {
      scope.dataState = 'stale'
      scope.latestAttempt = { jobId: 'demo-failed', state: 'failed', errorCode: 'timeout' }
    }
  })
  const slots: Slot[] = []
  if (scenario !== 'empty')
    for (const park of selected)
      for (let i = 0; i < 7; i++) {
        const date = offset(input.dateFrom, i)
        if (date > input.dateTo) break
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
        // Day +2 is an imaginary holiday, solely for checking the filter in this preview.
        if (!input.weekdays.includes(weekday) && !(input.includeHolidays && i === 2)) continue
        const scope = scopes.find(
          (s) =>
            s.parkId === park.parkId && s.surface === park.surface && s.weekStart === monday(date),
        )!
        if (!scope.snapshotId) continue
        for (const [start, end, count] of [
          ['09:00', '11:00', 2],
          ['13:00', '14:00', 1],
          ['14:00', '15:00', 1],
        ] as const) {
          if (
            minute(start) < minute(input.timeFrom) ||
            minute(end) > minute(input.timeTo) ||
            minute(end) - minute(start) < input.minDurationMinutes
          )
            continue
          slots.push({
            parkId: park.parkId,
            parkName: park.parkName,
            surface: park.surface,
            facilityId: `demo-${park.parkId}`,
            facilityName: `テニス（${park.label}）`,
            date,
            start,
            end,
            availableCourts: count,
            snapshotId: scope.snapshotId,
            observedAt,
          })
        }
      }
  slots.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start) ||
      a.parkId.localeCompare(b.parkId) ||
      a.facilityId.localeCompare(b.facilityId),
  )
  const count = scopes.filter((s) => s.snapshotId).length
  return {
    generatedAt,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    coverage: count === scopes.length ? 'complete' : count ? 'partial' : 'none',
    scopes,
    slots,
    officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
  }
}
