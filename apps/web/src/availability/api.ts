import { parks, type Conditions, type SearchResult } from './model'
import * as v from 'valibot'
import { ErrorSchema, SearchSchema, UpdatesSchema, JobSchema, type Job } from './schemas'
export type { Job } from './schemas'
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
        timeFrom: input.startTimes?.length ? '00:00' : input.timeFrom,
        timeTo: input.startTimes?.length ? '24:00' : input.timeTo,
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
      const parsed = v.safeParse(ErrorSchema, data)
      const code = parsed.success ? parsed.output.error.code : ''
      throw new RequestError(
        (Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : undefined) ??
          'APIを利用できません。時間をおいて再試行してください。',
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
  const parsed = v.safeParse(SearchSchema, data)
  if (!parsed.success)
    throw new RequestError('検索結果の形式を確認できません。再試行してください。')
  // The API's interval filter cannot express disjoint start times. Request the full
  // day, then filter validated saved slots; preserve the API's coverage metadata.
  return {
    ...parsed.output,
    slots: input.startTimes?.length
      ? parsed.output.slots.filter((slot) => input.startTimes.includes(slot.start))
      : parsed.output.slots,
  }
}
export async function updates(
  input: Conditions,
  signal: AbortSignal,
): Promise<{ jobs: Job[]; pollAfterSeconds: number }> {
  const data = await request('updates', signal, payload(input, true))
  const parsed = v.safeParse(UpdatesSchema, data)
  if (!parsed.success)
    throw new RequestError('更新応答の形式を確認できません。保存済み情報を再検索してください。')
  return parsed.output
}
export async function job(id: string, signal: AbortSignal): Promise<Job> {
  const data = await request(`updates/${encodeURIComponent(id)}`, signal)
  const parsed = v.safeParse(JobSchema, data)
  if (!parsed.success || parsed.output.jobId !== id)
    throw new RequestError('進捗の形式を確認できません。再確認してください。')
  return parsed.output
}
