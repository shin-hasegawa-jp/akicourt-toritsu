import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireParkCatalog } from '../src/availability/client'
import {
  compareParkCatalog,
  checkParkCatalog,
  compareParkStorage,
  checkParkStorage,
} from '../src/storage/park-catalog'
import parks from '../src/storage/park-options'
import { Store } from '../src/storage/store'

const wire = (rows: unknown[], all = rows.length) =>
  new Response(
    JSON.stringify({ all, results: rows }).replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
  )
const options = { sleep: async () => {}, intervalMs: 0 }

test('catalog comparison reports additions, missing pairs and renames', () => {
  const local = [
    { parkId: '1000', surface: 'grass' as const, name: 'Old', enabled: true },
    { parkId: '1000', surface: 'hard' as const, name: 'Hard', enabled: true },
    { parkId: '2000', surface: 'grass' as const, name: 'Disabled', enabled: false },
  ]
  const official = [
    { parkId: '1000', surface: 'grass' as const, name: 'New' },
    { parkId: '2000', surface: 'grass' as const, name: 'Disabled' },
    { parkId: '3000', surface: 'hard' as const, name: 'Added' },
  ]
  const before = structuredClone(local)
  const result = compareParkCatalog(local, official)
  assert.deepEqual(result.added, [official[2]])
  assert.deepEqual(result.missing, [local[1]])
  assert.equal(result.renamed[0]?.previousName, 'Old')
  assert.deepEqual(local, before)
})

test('manual catalog fetch uses a separate session and exactly home plus two surface lists', async () => {
  const paths: string[] = []
  const purposes: string[] = []
  const result = await acquireParkCatalog({
    ...options,
    fetchImpl: async (url, init) => {
      paths.push(new URL(String(url)).pathname)
      if (paths.length === 1)
        return new Response('pawab2000', {
          headers: { 'set-cookie': 'session=catalog; Path=/web/; Secure' },
        })
      assert.match(new Headers(init?.headers).get('cookie') || '', /session=catalog/)
      purposes.push(new URLSearchParams(String(init?.body)).get('selectPpsCd')!)
      return wire([{ bcd: '1000', bcdNm: 'Park' }])
    },
  })
  assert.deepEqual(purposes, ['1030', '1020'])
  assert.equal(paths.length, 3)
  assert.ok(paths.slice(1).every((p) => p.includes('Favorite2')))
  assert.deepEqual(
    result.map((row) => row.surface),
    ['grass', 'hard'],
  )
})

test('malformed or unavailable official catalog fails rather than reporting removals', async () => {
  for (const response of [
    () => wire([]),
    () => wire([{ bcd: '1000', bcdNm: 'Park' }], 2),
    () =>
      wire([
        { bcd: '1000', bcdNm: 'A' },
        { bcd: '1000', bcdNm: 'B' },
      ]),
    () => new Response('<html>unavailable</html>'),
    () => new Response('blocked', { status: 429 }),
  ]) {
    let count = 0
    await assert.rejects(
      acquireParkCatalog({
        ...options,
        fetchImpl: async () => (++count === 1 ? new Response('pawab2000') : response()),
      }),
    )
    assert.equal(count, 2)
  }
})

test('check refuses concurrent worker ownership and releases its lease on failed acquisition', async () => {
  let releases = 0
  let requests = 0
  const unavailable = { takeLease: async () => false } as unknown as Store
  await assert.rejects(checkParkCatalog(unavailable), /worker-unavailable/)
  const store = {
    takeLease: async () => true,
    release: async () => {
      releases++
    },
    beforeRequest: async () => 0,
    heartbeat: async () => {},
    pool: {
      query: async (sql: string) => {
        assert.match(sql, /^SELECT/)
        return { rows: [] }
      },
    },
  } as unknown as Store
  await assert.rejects(
    checkParkCatalog(store, {
      ...options,
      fetchImpl: async () => {
        requests++
        return new Response('unavailable')
      },
    }),
  )
  assert.equal(requests, 1)
  assert.equal(releases, 1)
})

test('official comparison uses code even when storage catalog is unavailable', async () => {
  let requests = 0
  const store = {
    takeLease: async () => true,
    release: async () => {},
    beforeRequest: async () => 0,
    heartbeat: async () => {},
    pool: {
      query: async () => {
        throw new Error('catalog DB must not be read')
      },
    },
  } as unknown as Store
  const report = await checkParkCatalog(store, {
    ...options,
    fetchImpl: async () => {
      if (++requests === 1) return new Response('pawab2000')
      const surface = requests === 2 ? 'grass' : 'hard'
      return wire(
        parks
          .filter((park) => park.surface === surface)
          .map((park) => ({ bcd: park.parkId, bcdNm: park.name })),
      )
    },
  })
  assert.equal(report.comparison, 'official-vs-code')
  assert.equal(report.codeCount, parks.length)
  assert.deepEqual(report.added, [])
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.renamed, [])
  assert.equal(requests, 3)
})

test('DB comparison detects drift and accepts disabled historical parks', async () => {
  const stored: { parkId: string; surface: 'grass' | 'hard'; name: string; enabled: boolean }[] =
    parks.map((park) => ({ ...park, enabled: true }))
  stored.push({ parkId: '9999', surface: 'grass', name: 'History', enabled: false })
  const store = {
    pool: {
      query: async (sql: string) => {
        assert.match(sql, /^SELECT/)
        return { rows: stored }
      },
    },
  } as unknown as Store
  const report = await checkParkStorage(store)
  assert.equal(report.synchronized, true)
  assert.equal(report.retainedDisabled.length, 1)
  const changed = stored.slice(1).map((row) => ({ ...row }))
  changed[0]!.name = 'Old name'
  changed[1]!.enabled = false
  changed[changed.length - 1]!.enabled = true
  const result = compareParkStorage([...parks], changed)
  assert.equal(result.synchronized, false)
  assert.deepEqual(result.missing, [parks[0]])
  assert.equal(result.renamed[0]?.storedName, 'Old name')
  assert.equal(result.disabled.length, 1)
  assert.equal(result.unexpectedEnabled.length, 1)
  assert.equal(result.retainedDisabled.length, 0)
})
