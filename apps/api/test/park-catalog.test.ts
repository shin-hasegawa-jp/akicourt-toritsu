import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireParkCatalog } from '../src/availability/client'

const wire = (rows: unknown[], all = rows.length) =>
  new Response(
    JSON.stringify({ all, results: rows }).replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
  )
const options = { sleep: async () => {}, intervalMs: 0 }

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
