import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../App.vue'
import { parkGroups, parks, defaults, validate } from '../../availability/model'
import { payload } from '../../availability/api'
import { restoreConditions, saveConditions } from '../../availability/preferences'
import official from './fixtures/official-parks.json'

afterEach(() => vi.unstubAllGlobals())
describe('official tennis park choices', () => {
  it('matches the complete official lists and their order by surface', () => {
    expect(parkGroups.map((group) => group.surface)).toEqual(['hard', 'grass'])
    for (const group of parkGroups)
      expect(group.parks.map((park) => ({ id: park.parkId, name: park.parkName }))).toEqual(
        official[group.surface],
      )
    expect(parks).toHaveLength(31)
    const wrapper = mount(App)
    expect(
      wrapper.findAll('.target-option input').map((input) => input.attributes('value')),
    ).toEqual(parks.map((park) => park.key))
    expect(wrapper.findAll('.target-group-title').map((title) => title.text())).toEqual([
      'テニス（ハード）',
      'テニス（人工芝）',
    ])
    wrapper.unmount()
  })
  it('accepts every official choice while keeping the five-target limit and previous default', () => {
    expect(defaults().targets).toEqual(['1280:grass'])
    for (const park of parks) {
      const input = { ...defaults(), targets: [park.key] }
      expect(validate(input)).toBeNull()
      expect(payload(input).targets).toEqual([{ parkId: park.parkId, surface: park.surface }])
    }
    expect(validate({ ...defaults(), targets: ['1000:hard'] })).toBeTruthy()
    expect(
      validate({ ...defaults(), targets: parks.slice(0, 6).map((park) => park.key) }),
    ).toBeTruthy()
    expect(payload({ ...defaults(), targets: ['1315:grass', '1315:hard'] }).targets).toEqual([
      { parkId: '1315', surface: 'hard' },
      { parkId: '1315', surface: 'grass' },
    ])
  })
  it('persists new choices and restores them without old dates', () => {
    let saved = ''
    const storage = {
      setItem: (_key: string, value: string) => {
        saved = value
      },
      getItem: () => saved,
    }
    const input = {
      ...defaults(),
      targets: ['1350:hard' as const, '1360:grass' as const],
      dateFrom: '2020-01-01',
      dateTo: '2020-01-07',
    }
    expect(saveConditions(storage, input)).toBe('')
    expect(restoreConditions(storage).conditions.targets).toEqual(input.targets)
    expect(restoreConditions(storage).conditions.dateFrom).toBe(defaults().dateFrom)
  })
})
