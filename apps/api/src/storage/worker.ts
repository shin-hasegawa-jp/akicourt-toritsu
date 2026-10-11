import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquire, AcquisitionSession, Options } from '../availability/client'
import { Store } from './store'

export async function work(
  store: Store,
  signal: AbortSignal,
  options: Options = {},
  once = false,
): Promise<void> {
  const owner = randomUUID()
  if (!(await store.takeLease(owner))) throw new Error('worker-unavailable')
  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
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
  const session = new AcquisitionSession()
  try {
    while (!combined.aborted) {
      const job = await store.claim(owner)
      if (!job) {
        if (once) break
        await sleep(1000, undefined, { signal: combined })
        continue
      }
      const [result] = await acquire(
        [{ parkId: job.park_id, surface: job.surface, startDate: job.week_start }],
        {
          ...options,
          session,
          signal: combined,
          intervalMs: 0,
          beforeRequest: async () => {
            while (true) {
              combined.throwIfAborted()
              const wait = await store.beforeRequest(owner)
              if (!wait) return
              await sleep(wait, undefined, { signal: combined })
            }
          },
          onProgress: (count) => store.progress(owner, job, count),
        },
      )
      await store.finish(owner, job, result)
      console.log(
        JSON.stringify({
          jobId: job.id,
          state: result.state,
          requestCount: result.requests.length,
          ...(result.state === 'failed' ? { error: result.error } : {}),
        }),
      )
      if (result.state === 'failed' && result.error === 'access-blocked') break
      if (once) break
    }
  } catch (error) {
    if (!combined.aborted) throw error
  } finally {
    clearInterval(timer)
    await store.release(owner)
  }
}
