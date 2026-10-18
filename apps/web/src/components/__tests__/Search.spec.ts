import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../../App.vue'
import { defaults, today, validate, type SearchResult } from '../../availability/model'
import { payload, type Job } from '../../availability/api'

const result = (coverage: 'none' | 'complete' = 'none'): SearchResult => {
  const form = defaults()
  return {
    generatedAt: new Date().toISOString(),
    dateFrom: form.dateFrom,
    dateTo: form.dateTo,
    coverage,
    scopes: [
      {
        parkId: '1280',
        surface: 'grass',
        weekStart: form.dateFrom,
        dataState: coverage === 'none' ? 'unavailable' : 'fresh',
        snapshotId: coverage === 'none' ? null : 'test-snapshot',
        lastSuccessAt: coverage === 'none' ? null : new Date().toISOString(),
        latestAttempt: null,
      },
    ],
    slots: [],
    officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
  }
}
const job = (state: Job['state'] = 'running'): Job => ({
  jobId: 'test-job',
  parkId: '1280',
  surface: 'grass',
  weekStart: defaults().dateFrom,
  state,
  requestCount: 3,
  retryAfter: 0,
  errorCode: state === 'failed' ? 'timeout' : null,
  queuedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: state === 'succeeded' || state === 'failed' ? new Date().toISOString() : null,
})
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('API search and asynchronous updates', () => {
  it('uses Japan today and seven inclusive days; omits zero duration and filters from updates', () => {
    expect(today(new Date('2026-10-09T15:00:00Z'))).toBe('2026-10-10')
    const input = defaults()
    expect((Date.parse(input.dateTo) - Date.parse(input.dateFrom)) / 86400000).toBe(6)
    expect(validate({ ...input, dateFrom: '2026-02-30', dateTo: '2026-03-01' })).toBeTruthy()
    expect(payload(input)).not.toHaveProperty('minDurationMinutes')
    expect(payload(input, true)).not.toHaveProperty('weekdays')
  })
  it('rejects stale responses even when transport ignores abort; keeps conditions editable', async () => {
    let finish!: (value: Response) => void
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await wrapper.get('#duration').setValue('120')
    expect((wrapper.get('#duration').element as HTMLSelectElement).value).toBe('120')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('条件に合う枠はありません')
    finish(response(result('none')))
    await flushPromises()
    expect(wrapper.text()).not.toContain('「空きなし」という意味ではありません')
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    wrapper.unmount()
  })
  it('reports safe API errors, retains the previous result and allows retry', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(
        response(
          { error: { code: 'holiday_calendar_unavailable', message: 'private database details' } },
          503,
        ),
      )
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('#duration').setValue('120')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('祝日情報が未登録')
    expect(wrapper.text()).not.toContain('private database')
    expect(wrapper.text()).toContain('「空きなし」という意味ではありません')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role=alert]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('suppresses double updates, polls progress and refreshes after terminal failure', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(response({ jobs: [job()], pollAfterSeconds: 3 }, 202))
      .mockResolvedValueOnce(response(job('failed')))
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const button = wrapper.get('.update-controls button')
    await button.trigger('click')
    await button.trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('通信3件')
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(fetch.mock.calls[2]![0]).toBe('/api/availability/updates/test-job')
    expect(wrapper.text()).toContain('一部の取得が失敗')
    expect(wrapper.text()).toContain('取得失敗')
    expect(fetch).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetch).toHaveBeenCalledTimes(4)
    wrapper.unmount()
  })
  it('stops polling on edits and unmount, discarding delayed job progress', async () => {
    vi.useFakeTimers()
    let finish!: (value: Response) => void
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(response({ jobs: [job()], pollAfterSeconds: 3 }, 202))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    await wrapper.get('#duration').setValue('120')
    finish(response(job('succeeded')))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toContain('サーバーで継続')
    expect(wrapper.text()).toContain('前回検索時の条件')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries job status without resubmitting the update', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(response({ jobs: [job()], pollAfterSeconds: 3 }, 202))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(job('succeeded')))
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    const retry = wrapper.findAll('button').find((b) => b.text() === '進捗を再確認')!
    await retry.trigger('click')
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(fetch.mock.calls.filter(([url]) => url === '/api/availability/updates')).toHaveLength(1)
    expect(wrapper.text()).toContain('取得処理が完了')
    wrapper.unmount()
  })
  it('stops polling on 429, preserves results and resumes only on manual confirmation', async () => {
    vi.useFakeTimers()
    const limited = new Response(
      JSON.stringify({ error: { code: 'rate_limited', message: 'private detail' } }),
      { status: 429, headers: { 'Retry-After': '30' } },
    )
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(response({ jobs: [job()], pollAfterSeconds: 3 }, 202))
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce(response(job('succeeded')))
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.text()).toContain('30秒ほど待って')
    expect(wrapper.text()).not.toContain('private detail')
    expect(wrapper.text()).toContain('「空きなし」という意味ではありません')
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(3)
    const retry = wrapper.findAll('button').find((button) => button.text() === '進捗を再確認')!
    await retry.trigger('click')
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(wrapper.text()).toContain('取得処理が完了')
    wrapper.unmount()
  })
  it('shows paused admission without asking users to start the worker and allows manual retry', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(
        response({ error: { code: 'worker_unavailable', message: 'private detail' } }, 503),
      )
      .mockResolvedValueOnce(response({ jobs: [job('succeeded')], pollAfterSeconds: 3 }))
      .mockResolvedValueOnce(response(result('complete')))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('更新受付は停止しています')
    expect(wrapper.text()).not.toContain('起動状態を確認')
    expect(wrapper.text()).not.toContain('private detail')
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('取得処理が完了')
    wrapper.unmount()
  })
  it('times out a search and aborts in-flight polling on unmount', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('abort'))),
          ),
      )
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await vi.advanceTimersByTimeAsync(35000)
    await flushPromises()
    expect(wrapper.text()).toContain('応答に時間がかかっています')
    await wrapper.get('form').trigger('submit')
    wrapper.unmount()
    await flushPromises()
    expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels an active job request on unmount and rejects malformed search data', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(result()))
      .mockResolvedValueOnce(response({ jobs: [job()], pollAfterSeconds: 3 }, 202))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('abort')))
          }),
      )
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('.update-controls button').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    wrapper.unmount()
    await flushPromises()
    expect(fetch.mock.calls[2]![1]!.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    fetch.mockResolvedValueOnce(response({ slots: [] }))
    const malformed = mount(App)
    await malformed.get('form').trigger('submit')
    await flushPromises()
    expect(malformed.text()).toContain('検索結果の形式を確認できません')
    expect(malformed.text()).not.toContain('条件に合う枠はありません')
    malformed.unmount()
  })
})
