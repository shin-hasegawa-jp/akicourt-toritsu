import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../../App.vue'
import { defaults, type Slot } from '../../availability/model'
import { slotText, restoreConditions, saveConditions } from '../../availability/preferences'

async function searchWithSlot() {
  const slot: Slot = {
    parkId: '1280',
    surface: 'grass',
    parkName: '東大和南公園',
    facilityId: 'test-facility',
    facilityName: 'テニス（人工芝）',
    date: defaults().dateFrom,
    start: '09:00',
    end: '11:00',
    availableCourts: 1,
    snapshotId: 'test-snapshot',
    observedAt: new Date().toISOString(),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          generatedAt: slot.observedAt,
          dateFrom: defaults().dateFrom,
          dateTo: defaults().dateTo,
          coverage: 'complete',
          officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
          scopes: [
            {
              parkId: slot.parkId,
              surface: slot.surface,
              weekStart: slot.date,
              dataState: 'fresh',
              snapshotId: slot.snapshotId,
              lastSuccessAt: slot.observedAt,
              latestAttempt: null,
            },
          ],
          slots: [slot],
        }),
      ),
    ),
  )
  const wrapper = mount(App)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return { wrapper, slot }
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('saved conditions and official handoff', () => {
  it('restores selected filters, always resets dates, and never starts acquisition on restore', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
    saveConditions(localStorage, { ...defaults(), weekdays: [0, 6], minDurationMinutes: 120 })
    vi.setSystemTime(new Date('2026-10-11T00:00:00Z'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(App)
    expect((wrapper.get('#duration').element as HTMLSelectElement).value).toBe('120')
    expect((wrapper.get('#date-from').element as HTMLInputElement).value).toBe('2026-10-11')
    expect((wrapper.get('#date-to').element as HTMLInputElement).value).toBe('2026-10-17')
    expect(wrapper.text()).not.toContain('条件を復元しました')
    expect(wrapper.text()).not.toContain('自動保存されます')
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('falls back for corrupt, incompatible or inaccessible saved data; rejects invalid saves', () => {
    for (const raw of [
      '{',
      JSON.stringify({ version: 3, conditions: defaults() }),
      JSON.stringify({ version: 1, conditions: { ...defaults(), targets: ['unknown'] } }),
    ]) {
      expect(restoreConditions({ getItem: () => raw }).conditions).toEqual(defaults())
    }
    expect(
      restoreConditions({
        getItem: () => {
          throw new Error('denied')
        },
      }).conditions,
    ).toEqual(defaults())
    const setItem = vi.fn<Storage['setItem']>()
    expect(saveConditions({ setItem }, { ...defaults(), targets: [] })).toContain('選んで')
    expect(setItem).not.toHaveBeenCalled()
    expect(
      saveConditions(
        {
          setItem: () => {
            throw new Error('quota')
          },
        },
        defaults(),
      ),
    ).toContain('保存できません')
  })
  it('automatically saves filters without dates and restores them on remount', async () => {
    const wrapper = mount(App)
    await wrapper.get('#duration').setValue('120')
    const saved = JSON.parse(localStorage.getItem('akicourt.conditions.v1')!)
    expect(saved.conditions.minDurationMinutes).toBe(120)
    expect(saved.conditions).not.toHaveProperty('dateFrom')
    expect(saved.conditions).not.toHaveProperty('dateTo')
    await wrapper.get('#date-from').setValue('2026-11-01')
    await wrapper.get('#date-to').setValue('2026-11-07')
    expect(JSON.parse(localStorage.getItem('akicourt.conditions.v1')!)).toEqual(saved)
    wrapper.unmount()
    const restored = mount(App)
    expect((restored.get('#duration').element as HTMLSelectElement).value).toBe('120')
    expect((restored.get('#date-from').element as HTMLInputElement).value).toBe(defaults().dateFrom)
    expect((restored.get('#date-to').element as HTMLInputElement).value).toBe(defaults().dateTo)
    restored.unmount()
  })
  it('ignores future dates saved by the previous version while retaining filters', () => {
    const conditions = {
      ...defaults(),
      dateFrom: '2099-01-01',
      dateTo: '2099-01-07',
      minDurationMinutes: 120,
    }
    const restored = restoreConditions({
      getItem: () => JSON.stringify({ version: 1, conditions }),
    })
    expect(restored.conditions).toEqual({ ...defaults(), minDurationMinutes: 120 })
  })
  it('offers manual copy when clipboard is unavailable and opens only the official home', async () => {
    const { wrapper, slot } = await searchWithSlot()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'この枠の条件をコピー')!
      .trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(slotText(slot))
    expect(wrapper.get('a').attributes('href')).toBe('https://kouen.sports.metro.tokyo.lg.jp/web/')
    expect(wrapper.get('a').attributes('rel')).toContain('noopener')
    wrapper.unmount()
  })
  it('copies a result slot through the clipboard when available', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { wrapper, slot } = await searchWithSlot()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'この枠の条件をコピー')!
      .trigger('click')
    expect(writeText).toHaveBeenCalledWith(slotText(slot))
    expect(wrapper.text()).toContain('コピーしました')
    wrapper.unmount()
  })
})
