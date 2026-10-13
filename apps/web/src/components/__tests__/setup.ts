import { beforeEach } from 'vitest'
import { setParkCatalog } from '../../availability/parks'
import official from './fixtures/official-parks.json'

// Existing search tests run with a catalog already supplied by the API.
export const catalog = {
  defaultTarget: '1280:grass',
  groups: (['hard', 'grass'] as const).map((surface) => ({
    surface,
    label: surface === 'hard' ? 'ハード' : '人工芝',
    parks: official[surface].map((park) => ({ parkId: park.id, parkName: park.name })),
  })),
}
beforeEach(() => setParkCatalog(catalog))
