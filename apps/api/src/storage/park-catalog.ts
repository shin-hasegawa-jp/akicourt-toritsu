import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquireParkCatalog, CatalogPark, Options } from '../availability/client'
import { AcquisitionError } from '../availability/parser'
import { Store } from './store'

type LocalPark = CatalogPark & { enabled: boolean }
export function compareParkCatalog(local: LocalPark[], official: CatalogPark[]) {
  const key = (row: CatalogPark) => `${row.parkId}/${row.surface}`
  const known = new Map(local.map((row) => [key(row), row]))
  const current = new Map(official.map((row) => [key(row), row]))
  return {
    added: official.filter((row) => !known.has(key(row))),
    missing: local.filter((row) => !current.has(key(row))),
    renamed: official.flatMap((row) => {
      const old = known.get(key(row))
      return old && old.name !== row.name
        ? [{ ...row, previousName: old.name, enabled: old.enabled }]
        : []
    }),
    disabledButListed: local.filter((row) => !row.enabled && current.has(key(row))),
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
    const local = (
      await store.pool.query(
        'SELECT park_id AS "parkId",surface,name,enabled FROM park_surfaces ORDER BY park_id,surface',
      )
    ).rows as LocalPark[]
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
      localCount: local.length,
      officialCount: official.length,
      ...compareParkCatalog(local, official),
    }
  } catch (error) {
    if (error instanceof AcquisitionError && error.kind === 'access-blocked')
      await store.pool.query(
        "UPDATE worker_lease SET blocked_reason='access-blocked' WHERE id=1 AND owner=$1 AND expires_at>clock_timestamp()",
        [owner],
      )
    throw error
  } finally {
    clearInterval(timer)
    await store.release(owner)
  }
}
