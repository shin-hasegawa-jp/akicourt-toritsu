import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquireParkCatalog, CatalogPark, Options } from '../availability/client'
import { Store } from './store'
import parks from './park-options'

type LocalPark = CatalogPark & { enabled: boolean }
export function compareParkCatalog(local: CatalogPark[], official: CatalogPark[]) {
  const key = (row: CatalogPark) => `${row.parkId}/${row.surface}`
  const known = new Map(local.map((row) => [key(row), row]))
  const current = new Map(official.map((row) => [key(row), row]))
  return {
    added: official.filter((row) => !known.has(key(row))),
    missing: local.filter((row) => !current.has(key(row))),
    renamed: official.flatMap((row) => {
      const old = known.get(key(row))
      return old && old.name !== row.name ? [{ ...row, previousName: old.name }] : []
    }),
  }
}

// Takes the same exclusive lease as the acquisition worker; no catalog writes.
export async function checkParkCatalog(store: Store, options: Options = {}) {
  const owner = randomUUID()
  if (!(await store.takeLease(owner))) throw new Error('worker-unavailable')
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  let renewing = false
  const timer = setInterval(() => {
    if (renewing) return
    renewing = true
    void store
      .heartbeat(owner)
      .catch(() => controller.abort())
      .finally(() => {
        renewing = false
      })
  }, 20000)
  try {
    const local: CatalogPark[] = [...parks]
    const official = await acquireParkCatalog({
      ...options,
      signal,
      beforeRequest: async () => {
        while (true) {
          signal.throwIfAborted()
          const wait = await store.beforeRequest(owner)
          if (!wait) return
          await sleep(wait, undefined, { signal })
        }
      },
    })
    return {
      checkedAt: new Date().toISOString(),
      comparison: 'official-vs-code',
      codeCount: local.length,
      officialCount: official.length,
      ...compareParkCatalog(local, official),
    }
  } finally {
    clearInterval(timer)
    await store.release(owner)
  }
}

export function compareParkStorage(code: CatalogPark[], stored: LocalPark[]) {
  const key = (row: CatalogPark) => `${row.parkId}/${row.surface}`
  const expected = new Map(code.map((row) => [key(row), row]))
  const actual = new Map(stored.map((row) => [key(row), row]))
  const missing = code.filter((row) => !actual.has(key(row)))
  const renamed = code.flatMap((row) => {
    const found = actual.get(key(row))
    return found && found.name !== row.name ? [{ ...row, storedName: found.name }] : []
  })
  const disabled = code.filter((row) => actual.get(key(row))?.enabled === false)
  const unexpectedEnabled = stored.filter((row) => row.enabled && !expected.has(key(row)))
  const retainedDisabled = stored.filter((row) => !row.enabled && !expected.has(key(row)))
  return {
    synchronized:
      !missing.length && !renamed.length && !disabled.length && !unexpectedEnabled.length,
    missing,
    renamed,
    disabled,
    unexpectedEnabled,
    retainedDisabled,
  }
}

// Read-only DB comparison: no official requests or acquisition lease needed.
export async function checkParkStorage(store: Store) {
  const stored = (
    await store.pool.query(
      'SELECT park_id AS "parkId",surface,name,enabled FROM park_surfaces ORDER BY park_id,surface',
    )
  ).rows as LocalPark[]
  return {
    checkedAt: new Date().toISOString(),
    comparison: 'code-vs-db',
    codeCount: parks.length,
    storedCount: stored.length,
    ...compareParkStorage([...parks], stored),
  }
}
