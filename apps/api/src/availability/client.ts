import { CookieJar } from 'tough-cookie'
import { performance } from 'node:perf_hooks'
import {
  AcquisitionError,
  offsetDate,
  parseFacilities,
  parseParks,
  parseWeek,
  validateDate,
  Week
} from './parser'

const base = 'https://kouen.sports.metro.tokyo.lg.jp'
export type Target = {
  parkId: string
  surface: 'grass' | 'hard'
  startDate: string
}
type Metric = {
  path: string
  status?: number
  durationMs: number
  attempt: number
}
type Facility = { id: string; name: string; week: Week }
export type Result = {
  target: Target
  parkName?: string
  attemptedAt: string
  completedAt: string
  durationMs: number
  requests: Metric[]
} & (
  | { state: 'success'; facilities: Facility[] }
  | { state: 'failed'; error: string }
)
// Owned by one sequential worker; cookies never leave process memory.
export class AcquisitionSession {
  readonly jar = new CookieJar()
  initialized = false
  readonly prepared = new Set<string>()
  initializationRetryAt = 0
  initializationError = 'invalid-home'
  readonly targets = new Map<string, { parkName: string; facilities: Array<{ id: string; name: string }> }>()
}

export type Options = {
  parkName?: string
  session?: AcquisitionSession
  signal?: AbortSignal
  beforeRequest?: () => Promise<void>
  onProgress?: (count: number) => Promise<void>
  fetchImpl?: typeof fetch
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
}
const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

class Session {
  private readonly jar: CookieJar
  readonly metrics: Metric[] = []
  constructor(private readonly options: Options, state: AcquisitionSession) {
    this.jar = state.jar
  }
  async request(
    path: string,
    fields?: Record<string, string>
  ): Promise<string> {
    // Paths are constants supplied by this module, never user-provided URLs.
    const url = `${base}${path}`
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.metrics.length)
        await (this.options.sleep || pause)(this.options.intervalMs ?? 2000)
      this.options.signal?.throwIfAborted()
      await this.options.beforeRequest?.()
      this.options.signal?.throwIfAborted()
      const started = performance.now()
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 45000
      )
      const metric: Metric = { path, durationMs: 0, attempt: attempt + 1 }
      this.metrics.push(metric)
      try {
        const cookie = await this.jar.getCookieString(url)
        const response = await (this.options.fetchImpl || fetch)(url, {
          method: fields ? 'POST' : 'GET',
          redirect: 'manual',
          signal: this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(fields
              ? { 'content-type': 'application/x-www-form-urlencoded' }
              : {})
          },
          ...(fields ? { body: new URLSearchParams(fields).toString() } : {})
        })
        metric.status = response.status
        for (const value of response.headers.getSetCookie())
          await this.jar.setCookie(value, url)
        // Reject redirects rather than silently following a login/error route.
        if (response.status >= 300 && response.status < 400)
          throw new AcquisitionError('unexpected-redirect')
        if (response.status === 403 || response.status === 429)
          throw new AcquisitionError('access-blocked')
        if (!response.ok)
          throw new AcquisitionError(
            response.status >= 500 ? 'server-error' : 'http-error'
          )
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 2_000_000)
          throw new AcquisitionError('response-too-large')
        let text: string
        try {
          text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
        } catch {
          throw new AcquisitionError('invalid-encoding')
        }
        if (/<html[\s>]/i.test(text) && text.includes('セッションタイムアウトが発生しました。'))
          throw new AcquisitionError('session-expired')
        return text
      } catch (error) {
        const classified =
          error instanceof AcquisitionError
            ? error
            : new AcquisitionError(
                this.options.signal?.aborted ? 'interrupted' : controller.signal.aborted ? 'timeout' : 'network-error'
              )
        if (
          attempt === 0 &&
          ['network-error', 'timeout', 'server-error'].includes(classified.kind)
        )
          continue
        throw classified
      } finally {
        clearTimeout(timer)
        metric.durationMs = Math.round(performance.now() - started)
        await this.options.onProgress?.(this.metrics.length)
      }
    }
    throw new AcquisitionError('network-error')
  }
}

export async function acquire(
  targets: Target[],
  options: Options = {}
): Promise<Result[]> {
  // This verification entry point is intentionally limited to five targets and one week each.
  if (!targets.length || targets.length > 5)
    throw new Error('Specify one to five targets')
  for (const target of targets) {
    if (
      !/^\d{4}$/.test(target.parkId) ||
      !['grass', 'hard'].includes(target.surface)
    )
      throw new Error('Invalid target')
    validateDate(target.startDate)
    offsetDate(target.startDate, 6)
  }
  const results: Result[] = []
  for (const target of targets) {
    if (results.length)
      await (options.sleep || pause)(options.intervalMs ?? 2000)
    const state = options.session || new AcquisitionSession()
    const session = new Session(options, state)
    const started = performance.now()
    const attemptedAt = new Date().toISOString()
    let parkName: string | undefined
    try {
      for (let recovery = 0; recovery < 2; recovery++) {
        try {
          if (Date.now() < state.initializationRetryAt)
            throw new AcquisitionError(state.initializationError)
          if (!state.initialized) {
            try {
              const home = await session.request('/web/')
              if (!home.includes('pawab2000')) throw new AcquisitionError('invalid-home')
              state.initialized = true
              state.prepared.clear()
              state.initializationRetryAt = 0
            } catch (error) {
              state.initializationRetryAt = Date.now() + 15 * 60 * 1000
              state.initializationError = error instanceof AcquisitionError ? error.kind : 'invalid-response'
              throw error
            }
          }
          const key = `${target.parkId}/${target.surface}`
          let cached = state.targets.get(key)
          if (!cached) cached = { parkName: options.parkName || target.parkId, facilities: [] }
          if (!state.prepared.has(key)) {
            const purpose = target.surface === 'grass' ? '1030' : '1020'
            const facilities = parseFacilities(
              await session.request('/web/rsvWOpeInstSrchVacantAction.do', {
                daystart: target.startDate,
                daystarthome: target.startDate,
                selectPpsClPpscd: `1000_${purpose}`,
                selectPpsClsCd: '1000',
                selectPpsCd: purpose,
                selectAreaBcd: target.parkId,
                selectBldCd: target.parkId,
                selectIcd: '0',
                dayofweekClearFlg: '1',
                timezoneClearFlg: '1',
                displayNo: 'pawab2000',
                displayNoFrm: 'pawab2000'
              }),
              target.parkId
            )
            if (facilities.length > 4)
              throw new AcquisitionError('too-many-facilities')
            cached = { parkName: cached!.parkName, facilities }
            state.prepared.add(key)
            state.targets.set(key, cached)
          }
          parkName = cached!.parkName
          const collected: Facility[] = []
          for (const facility of cached!.facilities) {
            const week = parseWeek(
              await session.request('/web/rsvWOpeInstSrchVacantAjaxAction.do', {
                displayNo: 'prwrc2000',
                useDay: target.startDate.replaceAll('-', ''),
                bldCd: target.parkId,
                instCd: facility.id,
                transVacantMode: '11',
                clearFlag: '0'
              }),
              target.startDate
            )
            collected.push({ ...facility, week })
          }
          results.push({
            target,
            parkName,
            attemptedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
            requests: session.metrics,
            state: 'success',
            facilities: collected
          })
          break
        } catch (error) {
          if (error instanceof AcquisitionError && error.kind === 'session-expired') {
            state.initialized = false
            state.prepared.clear()
            await state.jar.removeAllCookies()
            if (recovery === 0) continue
          }
          if (recovery === 1) {
            state.initialized = false
            state.prepared.clear()
            state.initializationRetryAt = Date.now() + 15 * 60 * 1000
            state.initializationError = error instanceof AcquisitionError ? error.kind : 'invalid-response'
          }
          throw error
        }
      }
    } catch (error) {
      // A failed target never carries an empty successful result or unvalidated partial data.
      results.push({
        target,
        parkName,
        attemptedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        requests: session.metrics,
        state: 'failed',
        error:
          options.signal?.aborted ? 'interrupted' : error instanceof AcquisitionError ? error.kind : 'invalid-response'
      })
    }
  }
  return results
}


export type CatalogPark = { parkId: string; surface: 'grass' | 'hard'; name: string }

export async function acquireParkCatalog(options: Options = {}): Promise<CatalogPark[]> {
  const session = new Session(options, new AcquisitionSession())
  const home = await session.request('/web/')
  if (!home.includes('pawab2000')) throw new AcquisitionError('invalid-home')
  const output: CatalogPark[] = []
  for (const surface of ['grass', 'hard'] as const) {
    const rows = parseParks(await session.request('/web/rsvWTransFavorite2InfoBuildAjaxAction.do', {
      displayNo: 'prwre1000', selectPpsdCd: '1000',
      selectPpsCd: surface === 'grass' ? '1030' : '1020', selectAreaCd: '0'
    }))
    if (new Set(rows.map(r => r.id)).size !== rows.length || rows.some(r => !/^\d{4}$/.test(r.id)))
      throw new AcquisitionError('invalid-response')
    output.push(...rows.map(row => ({ parkId: row.id, surface, name: row.name })))
  }
  return output
}
