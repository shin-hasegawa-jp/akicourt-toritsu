import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireParkCatalog } from '../src/availability/client'
import { compareParkCatalog, checkParkCatalog } from '../src/storage/park-catalog'
import { Store } from '../src/storage/store'

const wire = (rows: unknown[], all = rows.length) =>
  new Response(JSON.stringify({ all, results: rows }))
const options = { sleep: async () => {}, intervalMs: 0 }

test('catalog comparison reports additions, missing pairs, renames and disabled listings', () => {
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
  assert.deepEqual(result.disabledButListed, [local[2]])
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
