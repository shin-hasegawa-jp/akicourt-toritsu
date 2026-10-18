import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { acquire, Result } from '../availability/client'
import { AcquisitionError } from '../availability/parser'
import { DispatchJob } from '../storage/firestore/jobs'
import { OfficialSessionRepository } from '../storage/firestore/official-session'
import { WorkerStore } from '../storage/firestore/worker-store'

type Timing = { abortMs: number; deadlineMs: number; heartbeatMs: number; storageMs: number }
const timing: Timing = { abortMs: 830000, deadlineMs: 839000, heartbeatMs: 20000, storageMs: 5000 }
type Dependencies = {
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  timing?: Timing
}
const businessError = (error: unknown) =>
  error instanceof AcquisitionError &&
  ['updates-disabled', 'session-recovery-required', 'access-blocked'].includes(error.kind)

// Run inside the task's HTTP lifetime. No acquisition is scheduled after the reply.
export class AcquisitionWorker {
  constructor(
    private readonly store: WorkerStore,
    private readonly sessions: OfficialSessionRepository,
    private readonly dependencies: Dependencies = {},
  ) {}
  async run(task: DispatchJob, externalSignal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, externalSignal])
    const limits = this.dependencies.timing ?? timing
    const started = performance.now()
    const abortTimer = setTimeout(() => controller.abort(), limits.abortMs)
    let infrastructureFailure = false
    let renewal: Promise<void> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let requestCount = 0
    // SDK operations cannot be cancelled. On timeout, stop this invocation;
    // a late commit is fenced, or leaves an unpublished snapshot / leased job.
    const io = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = Math.min(
        limits.storageMs,
        limits.deadlineMs - (performance.now() - started),
      )
      if (remaining <= 0) throw new Error('worker-storage-unavailable')
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('worker-storage-unavailable')), remaining)
          }),
        ])
      } catch (error) {
        if (error instanceof Error && error.message === 'snapshot-capacity-exceeded') throw error
        if (!businessError(error)) infrastructureFailure = true
        controller.abort()
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }
    const sleep =
      this.dependencies.sleep ??
      (async (ms, abort) => {
        await delay(ms, undefined, { signal: abort })
      })
    try {
      signal.throwIfAborted()
      const claim = await io(() => this.store.claim(task))
      if (!claim) return
      const failed = (error: string): Result => ({
        target: claim.target,
        parkName: claim.parkName,
        state: 'failed',
        error,
        attemptedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        requests: [],
      })
      heartbeat = setInterval(() => {
        renewal ??= io(() => this.store.heartbeat(claim, requestCount))
          .catch(() => {
            controller.abort()
          })
          .finally(() => {
            renewal = undefined
          })
      }, limits.heartbeatMs)
      let result: Result
      try {
        const loaded = await io(() => this.sessions.load(claim))
        signal.throwIfAborted()
        const results = await acquire([claim.target], {
          parkName: claim.parkName,
          session: loaded.state,
          signal,
          checkpoint: (state, event) => io(() => loaded.checkpoint(state, event)),
          beforeRequest: async () => {
            for (;;) {
              signal.throwIfAborted()
              const wait = await io(() => this.store.gate(claim))
              if (!wait) return
              await sleep(wait, signal)
            }
          },
          onProgress: async (count) => {
            requestCount = count
          },
          intervalMs: 0,
          sleep: (ms) => sleep(ms, signal),
          fetchImpl: this.dependencies.fetchImpl,
        })
        result = results[0]
      } catch (error) {
        if (!signal.aborted && !businessError(error)) throw error
        result = failed(error instanceof AcquisitionError ? error.kind : 'interrupted')
      }
      if (infrastructureFailure) throw new Error('worker-storage-unavailable')
      if (signal.aborted && result.state === 'success')
        result = { ...result, state: 'failed', error: 'interrupted' }
      let snapshotId: string | undefined
      if (result.state === 'success') {
        try {
          const success = result
          snapshotId = (await io(() => this.store.snapshots.stage(success))).snapshotId
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'snapshot-capacity-exceeded')
            throw error
          // Capacity rejection happens before a DB write and is a terminal business failure.
          result = { ...result, state: 'failed', error: 'snapshot-capacity-exceeded' }
        }
      }
      clearInterval(heartbeat)
      await renewal
      if (infrastructureFailure) throw new Error('worker-storage-unavailable')
      if (signal.aborted && result.state === 'success')
        result = { ...result, state: 'failed', error: 'interrupted' }
      await io(() => this.store.finish(claim, result, snapshotId))
    } finally {
      clearTimeout(abortTimer)
      clearInterval(heartbeat)
      controller.abort()
      await renewal
    }
  }
}
