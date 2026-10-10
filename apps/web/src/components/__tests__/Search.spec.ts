import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../App.vue'
import { defaults, preview, today, validate } from '../../availability/model'

afterEach(() => vi.unstubAllGlobals())
describe('mock search review', () => {
  it('uses Japan today and seven inclusive days', () => {
    expect(today(new Date('2026-10-09T15:00:00Z'))).toBe('2026-10-10')
    const input = defaults()
    expect((Date.parse(input.dateTo) - Date.parse(input.dateFrom)) / 86400000).toBe(6)
    expect(validate({ ...input, dateFrom: '2026-02-30', dateTo: '2026-03-01' })).toBeTruthy()
    expect(validate({ ...input, dateTo: '2099-12-31' })).toBeTruthy()
  })
  it('filters imaginary holidays, weekdays and whole slots without joining them', () => {
    const input = {
      ...defaults(),
      dateFrom: '2026-10-10',
      dateTo: '2026-10-16',
      weekdays: [],
      includeHolidays: true,
    }
    expect(preview(input, 'success').slots.every((slot) => slot.date === '2026-10-12')).toBe(true)
    expect(preview(input, 'success').slots).toHaveLength(3)
    expect(
      preview({ ...input, weekdays: [0], includeHolidays: false }, 'success').slots,
    ).toHaveLength(3)
    expect(
      preview({ ...input, timeFrom: '13:00', timeTo: '15:00', minDurationMinutes: 120 }, 'success')
        .slots,
    ).toHaveLength(0)
  })
  it('distinguishes unavailable, empty, partial and stale failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await wrapper.get('#date-from').setValue('2026-10-10')
    await wrapper.get('#date-to').setValue('2026-10-16')
    await wrapper.get('#scenario').setValue('none')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('「空きなし」という意味ではありません')
    await wrapper.get('#scenario').setValue('empty')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('保存済み情報に、条件に合う枠はありません')
    await wrapper.get('#scenario').setValue('partial')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('一部の範囲が未確認')
    await wrapper.get('#scenario').setValue('failed')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('前回の古い結果')
    expect(wrapper.text()).toContain('最新の取得に失敗')
    expect(wrapper.findAll('.slot').length).toBeGreaterThan(0)
    await wrapper.get('#scenario').setValue('queued')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('取得待ち（モック）')
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('keeps previous results on invalid input and announces edited conditions', async () => {
    const wrapper = mount(App)
    await wrapper.get('form').trigger('submit')
    const slots = wrapper.findAll('.slot').length
    await wrapper.get('#duration').setValue('120')
    expect(wrapper.text()).toContain('表示中の結果は前回検索時の条件')
    await wrapper.get('#date-to').setValue('')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toContain('最大7日間')
    expect(wrapper.findAll('.slot')).toHaveLength(slots)
    wrapper.unmount()
  })
})
