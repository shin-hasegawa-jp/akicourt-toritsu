import { Cookie, CookieJar, SerializedCookieJar } from 'tough-cookie'
import { AcquisitionSession } from './client'
import { AcquisitionError } from './parser'

export type SessionState = {
  cookieJar: SerializedCookieJar
  initialized: boolean
  prepared: string[]
  targets: { key: string; parkName: string; facilities: { id: string; name: string }[] }[]
  initializationRetryAt: number
  initializationError: string
}
function fail(): never {
  throw new AcquisitionError('session-recovery-required')
}
const key = (s: string) => /^\d{4}\/(grass|hard)$/.test(s)
export function serializeSession(state: AcquisitionSession): SessionState {
  return {
    cookieJar: JSON.parse(JSON.stringify(state.jar.serializeSync())) as SerializedCookieJar,
    initialized: state.initialized,
    prepared: [...state.prepared],
    targets: [...state.targets].map(([key, value]) => ({ key, ...value })),
    initializationRetryAt: state.initializationRetryAt,
    initializationError: state.initializationError,
  }
}
export function restoreSession(value: SessionState, now = new Date()) {
  try {
    if (
      !value ||
      typeof value.initialized !== 'boolean' ||
      !Array.isArray(value.prepared) ||
      !Array.isArray(value.targets) ||
      value.targets.length > 31 ||
      value.prepared.some((k) => typeof k !== 'string' || !key(k)) ||
      new Set(value.prepared).size !== value.prepared.length ||
      !Number.isSafeInteger(value.initializationRetryAt) ||
      value.initializationRetryAt < 0 ||
      typeof value.initializationError !== 'string' ||
      value.cookieJar?.version !== new CookieJar().serializeSync()!.version ||
      !Array.isArray(value.cookieJar.cookies)
    )
      return fail()
    const jar = CookieJar.deserializeSync(value.cookieJar)
    // Expired cookies must not make a persisted session look usable. Actual official
    // session validity (including IP binding) can only be learned from the response.
    const cookies = jar.getCookiesSync('https://kouen.sports.metro.tokyo.lg.jp/web/', {
      expire: false,
    })
    if (
      value.initialized &&
      (!cookies.length ||
        value.cookieJar.cookies.some((raw) => {
          const c = Cookie.fromJSON(raw)
          return !c || (c.expiryTime() ?? 0) <= now.getTime()
        }))
    )
      return fail()
    const state = new AcquisitionSession(jar)
    state.initialized = value.initialized
    state.initializationRetryAt = value.initializationRetryAt
    state.initializationError = value.initializationError
    for (const t of value.targets) {
      if (
        !t ||
        !key(t.key) ||
        state.targets.has(t.key) ||
        typeof t.parkName !== 'string' ||
        !Array.isArray(t.facilities) ||
        !t.facilities.length ||
        t.facilities.length > 4 ||
        t.facilities.some(
          (f) => !/^\d+$/.test(f.id) || typeof f.name !== 'string' || !f.name.trim(),
        ) ||
        new Set(t.facilities.map((f) => f.id)).size !== t.facilities.length
      )
        return fail()
      state.targets.set(t.key, { parkName: t.parkName, facilities: t.facilities })
    }
    for (const p of value.prepared) {
      if (!state.initialized || !state.targets.has(p)) return fail()
      state.prepared.add(p)
    }
    return state
  } catch {
    return fail()
  }
}
