import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../../App.vue'
import ParkPicker from '../ParkPicker.vue'
import { defaults, offset, type SearchResult } from '../../availability/model'
import { search } from '../../availability/api'

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
})
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function data(): SearchResult {
  const input = defaults()
  const base = {
    parkId: '1280',
    surface: 'grass' as const,
    parkName: '東大和南公園',
    facilityId: 'tennis',
    facilityName: 'テニス（人工芝）',
    availableCourts: 2,
    snapshotId: 'saved',
    observedAt: new Date().toISOString(),
  }
  return {
    generatedAt: base.observedAt,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    coverage: 'complete',
    officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
    scopes: [
      {
        parkId: base.parkId,
        surface: base.surface,
        weekStart: input.dateFrom,
        dataState: 'fresh',
        snapshotId: base.snapshotId,
        lastSuccessAt: base.observedAt,
        latestAttempt: null,
      },
    ],
    slots: [
      { ...base, date: input.dateFrom, start: '09:00', end: '11:00' },
      { ...base, date: input.dateFrom, start: '11:00', end: '13:00' },
      { ...base, date: offset(input.dateFrom, 1), start: '13:00', end: '16:00' },
    ],
  }
}
describe('responsive search design interactions', () => {
  it('stages park choices, searches names, enforces five targets and applies atomically', async () => {
    const wrapper = mount(ParkPicker, { props: { selected: ['1280:grass', '1310:hard', '1000:grass', '1040:grass'] } })
    wrapper.vm.open()
    await flushPromises()
    await wrapper.get('#park-query').setValue('有明')
    expect(wrapper.findAll('.target-option')).toHaveLength(3)
    await wrapper.get('input[value="1350:hard"]').setValue(true)
    expect(wrapper.get('input[value="1370:hard"]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.get('.picker-actions .btn-primary').trigger('click')
    expect(wrapper.emitted('apply')).toEqual([[['1280:grass', '1310:hard', '1000:grass', '1040:grass', '1350:hard']]])
    expect(wrapper.get('dialog').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })
  it('discards cancelled edits, retains selections across searches, and rejects empty selection', async () => {
    const wrapper = mount(ParkPicker, { props: { selected: ['1280:grass'] } })
    wrapper.vm.open()
    await flushPromises()
    await wrapper.get('input[value="1280:grass"]').setValue(false)
    expect(wrapper.get('.picker-actions .btn-primary').attributes('disabled')).toBeDefined()
    await wrapper.get('.picker-actions .btn-outline').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    wrapper.vm.open()
    await flushPromises()
    await wrapper.get('#park-query').setValue('見つからない公園')
    expect(wrapper.text()).toContain('一致する公園がありません')
    expect(wrapper.text()).toContain('1 / 5対象を選択中')
    await wrapper.get('.picker-actions .btn-primary').trigger('click')
    expect(wrapper.emitted('apply')).toEqual([[['1280:grass']]])
    wrapper.unmount()
  })
  it('filters disjoint starts without truncating seasonal three-hour slots or changing coverage', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(data())))
    vi.stubGlobal('fetch', fetch)
    const found = await search(
      { ...defaults(), startTimes: ['09:00', '13:00'], timeFrom: '12:00', timeTo: '15:00' },
      new AbortController().signal,
    )
    expect(found.slots.map((slot) => [slot.start, slot.end])).toEqual([
      ['09:00', '11:00'],
      ['13:00', '16:00'],
    ])
    expect(found.coverage).toBe('complete')
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
    expect(body.timeFrom).toBe('00:00')
    expect(body.timeTo).toBe('24:00')
    expect(body).not.toHaveProperty('startTimes')
  })
  it('selects a result day, restores all days and marks old results after filter edits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data()))),
    )
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.findAll('.slot')).toHaveLength(3)
    expect(wrapper.findAll('.date-button')).toHaveLength(7)
    expect(wrapper.get('#condition-form').classes()).toContain('mobile-collapsed')
    await wrapper.findAll('.date-button')[1]!.trigger('click')
    expect(wrapper.findAll('.slot')).toHaveLength(1)
    expect(wrapper.text()).toContain('13:00–16:00')
    await wrapper.get('.date-nav > button').trigger('click')
    expect(wrapper.findAll('.slot')).toHaveLength(3)
    await wrapper.get('.mobile-condition-toggle').trigger('click')
    await wrapper.get('input[aria-label="09:00開始"]').setValue(true)
    expect(wrapper.text()).toContain('前回検索時の条件')
    expect(wrapper.get('.update-controls button').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('does not crash when dates are cleared or mislabel unconfirmed dates as no vacancy', async () => {
    const missing = {
      ...data(),
      coverage: 'none',
      slots: [],
      scopes: data().scopes.map((scope) => ({
        ...scope,
        dataState: 'unavailable',
        snapshotId: null,
        lastSuccessAt: null,
      })),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(missing))),
    )
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(
      wrapper.findAll('.date-button').every((button) => button.text().includes('未確認')),
    ).toBe(true)
    expect(wrapper.text()).not.toContain('条件に合う枠はありません')
    await wrapper.get('#date-from').setValue('')
    expect(wrapper.text()).toContain('未指定')
    wrapper.unmount()
  })
})
