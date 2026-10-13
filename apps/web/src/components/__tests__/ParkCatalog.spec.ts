import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../../App.vue'
import { nextTick } from 'vue'
import { parks, defaultTarget, setParkCatalog } from '../../availability/parks'
import { defaults, validate } from '../../availability/model'

const changedCatalog = {
  defaultTarget: '9999:grass',
  groups: [
    { surface: 'grass', label: '人工芝', parks: [{ parkId: '9999', parkName: '新しい公園' }] },
  ],
}
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})
describe('API supplied park choices', () => {
  it('loads new API parks before restoring preferences and never starts acquisition', async () => {
    parks.splice(0)
    defaultTarget.value = ''
    const saved = {
      ...defaults(),
      targets: ['9999:grass'],
      weekdays: [0, 6],
      minDurationMinutes: 120,
    }
    localStorage.setItem(
      'akicourt.conditions.v1',
      JSON.stringify({ version: 2, conditions: saved }),
    )
    let finish!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await nextTick()
    expect(wrapper.get('.search-button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('公園一覧を読み込んでいます')
    expect(localStorage.getItem('akicourt.conditions.v1')).toContain('9999:grass')
    finish(new Response(JSON.stringify(changedCatalog)))
    await flushPromises()
    expect(wrapper.text()).toContain('新しい公園')
    expect(wrapper.get('#duration').element).toHaveProperty('value', '120')
    expect(wrapper.get('.search-button').attributes('disabled')).toBeUndefined()
    expect(
      wrapper.findAll('.target-option input').map((input) => input.attributes('value')),
    ).toEqual(['9999:grass'])
    expect(validate({ ...defaults(), targets: ['9999:grass'] })).toBeNull()
    expect(validate({ ...defaults(), targets: ['1280:grass'] })).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe('/api/availability/parks')
    wrapper.unmount()
  })
  it('keeps saved conditions on fetch failure and allows retry with changed names', async () => {
    parks.splice(0)
    defaultTarget.value = ''
    localStorage.setItem('akicourt.conditions.v1', 'saved-before-failure')
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify(changedCatalog)))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.get('.search-button').attributes('disabled')).toBeDefined()
    expect(localStorage.getItem('akicourt.conditions.v1')).toBe('saved-before-failure')
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('新しい公園')
    expect(wrapper.get('.search-button').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it('rejects malformed, duplicate and missing-default catalog responses atomically', () => {
    const before = [...parks]
    for (const data of [
      {},
      { ...changedCatalog, defaultTarget: '1000:hard' },
      {
        ...changedCatalog,
        groups: [
          {
            ...changedCatalog.groups[0],
            parks: [changedCatalog.groups[0]!.parks[0], changedCatalog.groups[0]!.parks[0]],
          },
        ],
      },
    ])
      expect(() => setParkCatalog(data)).toThrow(/Invalid/)
    expect(parks).toEqual(before)
  })
})
