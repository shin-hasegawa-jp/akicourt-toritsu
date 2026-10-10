import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../App.vue'
import { defaults } from '../../availability/model'
import { conditionsText, restoreConditions, saveConditions } from '../../availability/preferences'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('saved conditions and official handoff', () => {
  it('restores selected filters, resets past dates, and never starts acquisition on restore', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
    saveConditions(localStorage, { ...defaults(), weekdays: [0, 6], minDurationMinutes: 120 })
    vi.setSystemTime(new Date('2026-10-11T00:00:00Z'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(App)
    expect((wrapper.get('#duration').element as HTMLSelectElement).value).toBe('120')
    expect((wrapper.get('#date-from').element as HTMLInputElement).value).toBe('2026-10-11')
    expect((wrapper.get('#date-to').element as HTMLInputElement).value).toBe('2026-10-17')
    expect(wrapper.text()).toContain('過去の期間')
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('falls back for corrupt, incompatible or inaccessible saved data; rejects invalid saves', () => {
    for (const raw of [
      '{',
      JSON.stringify({ version: 2, conditions: defaults() }),
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
  it('saves only when explicitly requested and restores the saved version on remount', async () => {
    const wrapper = mount(App)
    await wrapper.get('#duration').setValue('120')
    expect(localStorage.length).toBe(0)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'このブラウザに条件を保存')!
      .trigger('click')
    wrapper.unmount()
    const restored = mount(App)
    expect((restored.get('#duration').element as HTMLSelectElement).value).toBe('120')
    await restored
      .findAll('button')
      .find((button) => button.text() === '保存条件を削除')!
      .trigger('click')
    expect(localStorage.length).toBe(0)
    expect((restored.get('#duration').element as HTMLSelectElement).value).toBe('120')
    restored.unmount()
  })
  it('offers manual copy when clipboard is unavailable and opens only the official home', async () => {
    const wrapper = mount(App)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '入力中の条件をコピー')!
      .trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(
      conditionsText(defaults()),
    )
    expect(wrapper.get('a').attributes('href')).toBe('https://kouen.sports.metro.tokyo.lg.jp/web/')
    expect(wrapper.get('a').attributes('rel')).toContain('noopener')
    wrapper.unmount()
  })
  it('copies current inputs through the clipboard when available', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mount(App)
    await wrapper.get('#duration').setValue('120')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '入力中の条件をコピー')!
      .trigger('click')
    expect(writeText).toHaveBeenCalledWith(
      conditionsText({ ...defaults(), minDurationMinutes: 120 }),
    )
    expect(wrapper.text()).toContain('コピーしました')
    wrapper.unmount()
  })
})
