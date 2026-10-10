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
type Options = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
}
const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

class Session {
  private readonly jar = new CookieJar()
  readonly metrics: Metric[] = []
  constructor(private readonly options: Options) {}
  async request(
    path: string,
    fields?: Record<string, string>
  ): Promise<string> {
    // Paths are constants supplied by this module, never user-provided URLs.
    const url = `${base}${path}`
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.metrics.length)
        await (this.options.sleep || pause)(this.options.intervalMs ?? 2000)
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
          signal: controller.signal,
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
        if (!response.ok)
          throw new AcquisitionError(
            response.status >= 500 ? 'server-error' : 'http-error'
          )
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 2_000_000)
          throw new AcquisitionError('response-too-large')
        try {
          return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
        } catch {
          throw new AcquisitionError('invalid-encoding')
        }
      } catch (error) {
        const classified =
          error instanceof AcquisitionError
            ? error
            : new AcquisitionError(
                controller.signal.aborted ? 'timeout' : 'network-error'
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
      }
    }
    throw new AcquisitionError('network-error')
  }
}

export async function acquire(
  targets: Target[],
  options: Options = {}
): Promise<Result[]> {
  // This verification entry point is intentionally limited to two targets and one week each.
  if (!targets.length || targets.length > 2)
    throw new Error('Specify one or two targets')
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
    const session = new Session(options)
    const started = performance.now()
    const attemptedAt = new Date().toISOString()
    let parkName: string | undefined
    try {
      const home = await session.request('/web/')
      if (!home.includes('pawab2000'))
        throw new AcquisitionError('invalid-home')
      const purpose = target.surface === 'grass' ? '1030' : '1020'
      const parks = parseParks(
        await session.request('/web/rsvWTransFavorite2InfoBuildAjaxAction.do', {
          displayNo: 'prwre1000',
          selectPpsdCd: '1000',
          selectPpsCd: purpose,
          selectAreaCd: '0'
        })
      )
      const park = parks.find((row) => row.id === target.parkId)
      if (!park) throw new AcquisitionError('park-not-found')
      parkName = park.name
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
      const collected: Facility[] = []
      if (facilities.length > 4)
        throw new AcquisitionError('too-many-facilities')
      for (const facility of facilities) {
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
          error instanceof AcquisitionError ? error.kind : 'invalid-response'
      })
    }
  }
  return results
}
