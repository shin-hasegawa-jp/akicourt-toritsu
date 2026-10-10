import { parks, type Conditions, type SearchResult } from './model'
export type Job = {
  jobId: string
  parkId: string
  surface: 'grass' | 'hard'
  weekStart: string
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  requestCount: number
  retryAfter: number
  errorCode: string | null
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  reused?: boolean
}
export class RequestError extends Error {}
const messages: Record<string, string> = {
  holiday_calendar_unavailable:
    '対象年の祝日情報が未登録です。曜日条件を変更して再検索してください。',
  worker_unavailable: '取得ワーカーが停止しています。起動状態を確認して再試行してください。',
  storage_unavailable: '保存先を利用できません。時間をおいて再試行してください。',
  invalid_request: '検索条件を確認してください。更新対象に過去の日付は指定できません。',
  job_not_found: '更新ジョブが見つかりません。保存済み情報を再検索してください。',
  response_too_large: '検索結果が上限を超えています。条件を見直してください。',
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const instant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const state = (v: unknown) => ['queued', 'running', 'succeeded', 'failed'].includes(String(v))
const nullableInstant = (v: unknown) => v === null || instant(v)
const target = (v: Record<string, unknown>) =>
  typeof v.parkId === 'string' && ['grass', 'hard'].includes(String(v.surface))
export function isJob(v: unknown): v is Job {
  return (
    record(v) &&
    target(v) &&
    typeof v.jobId === 'string' &&
    date(v.weekStart) &&
    state(v.state) &&
    Number.isInteger(v.requestCount) &&
    Number(v.requestCount) >= 0 &&
    Number.isInteger(v.retryAfter) &&
    Number(v.retryAfter) >= 0 &&
    (v.errorCode === null || typeof v.errorCode === 'string') &&
    instant(v.queuedAt) &&
    nullableInstant(v.startedAt) &&
    nullableInstant(v.completedAt)
  )
}
export function isSearch(v: unknown): v is SearchResult {
  return (
    record(v) &&
    instant(v.generatedAt) &&
    date(v.dateFrom) &&
    date(v.dateTo) &&
    ['complete', 'partial', 'none'].includes(String(v.coverage)) &&
    Array.isArray(v.scopes) &&
    v.scopes.length > 0 &&
    v.scopes.length <= 4 &&
    v.scopes.every(
      (s) =>
        record(s) &&
        target(s) &&
        date(s.weekStart) &&
        ['fresh', 'stale', 'unavailable'].includes(String(s.dataState)) &&
        (s.snapshotId === null || typeof s.snapshotId === 'string') &&
        nullableInstant(s.lastSuccessAt) &&
        (s.latestAttempt === null ||
          (record(s.latestAttempt) &&
            typeof s.latestAttempt.jobId === 'string' &&
            state(s.latestAttempt.state) &&
            (s.latestAttempt.errorCode === null || typeof s.latestAttempt.errorCode === 'string'))),
    ) &&
    Array.isArray(v.slots) &&
    v.slots.length <= 10000 &&
    v.slots.every(
      (s) =>
        record(s) &&
        target(s) &&
        ['parkName', 'facilityId', 'facilityName', 'snapshotId'].every(
          (k) => typeof s[k] === 'string',
        ) &&
        date(s.date) &&
        typeof s.start === 'string' &&
        /^[0-2]\d:[0-5]\d$/.test(s.start) &&
        typeof s.end === 'string' &&
        /^[0-2]\d:[0-5]\d$/.test(s.end) &&
        Number.isInteger(s.availableCourts) &&
        Number(s.availableCourts) > 0 &&
        instant(s.observedAt),
    ) &&
    v.officialUrl === 'https://kouen.sports.metro.tokyo.lg.jp/web/'
  )
}
export function payload(input: Conditions, update = false) {
  const base = {
    targets: parks
      .filter((p) => input.targets.includes(p.key))
      .map((p) => ({ parkId: p.parkId, surface: p.surface })),
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  }
  return update
    ? base
    : {
        ...base,
        weekdays: [...input.weekdays],
        includeHolidays: input.includeHolidays,
        timeFrom: input.timeFrom,
        timeTo: input.timeTo,
        ...(input.minDurationMinutes ? { minDurationMinutes: input.minDurationMinutes } : {}),
      }
}
async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 10000)
  try {
    const response = await fetch(`/api/availability/${path}`, {
      signal: AbortSignal.any([signal, timeout.signal]),
      ...(body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    })
    const data: unknown = await response.json()
    if (!response.ok) {
      const code = record(data) && record(data.error) ? String(data.error.code) : ''
      throw new RequestError(
        messages[code] ?? 'APIを利用できません。時間をおいて再試行してください。',
      )
    }
    return data
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof RequestError) throw error
    throw new RequestError(
      timeout.signal.aborted
        ? '応答に時間がかかっています。再試行してください。'
        : 'APIに接続できません。起動状態を確認して再試行してください。',
    )
  } finally {
    clearTimeout(timer)
  }
}
export async function search(input: Conditions, signal: AbortSignal): Promise<SearchResult> {
  const data = await request('search', signal, payload(input))
  if (!isSearch(data))
    throw new RequestError('検索結果の形式を確認できません。再試行してください。')
  return data
}
export async function updates(
  input: Conditions,
  signal: AbortSignal,
): Promise<{ jobs: Job[]; pollAfterSeconds: number }> {
  const data = await request('updates', signal, payload(input, true))
  if (
    !record(data) ||
    !Array.isArray(data.jobs) ||
    !data.jobs.length ||
    data.jobs.length > 4 ||
    !data.jobs.every(isJob) ||
    !Number.isInteger(data.pollAfterSeconds) ||
    Number(data.pollAfterSeconds) < 1 ||
    Number(data.pollAfterSeconds) > 60
  )
    throw new RequestError('更新応答の形式を確認できません。保存済み情報を再検索してください。')
  return { jobs: data.jobs, pollAfterSeconds: Number(data.pollAfterSeconds) }
}
export async function job(id: string, signal: AbortSignal): Promise<Job> {
  const data = await request(`updates/${encodeURIComponent(id)}`, signal)
  if (!isJob(data) || data.jobId !== id)
    throw new RequestError('進捗の形式を確認できません。再確認してください。')
  return data
}
