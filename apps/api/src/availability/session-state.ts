import * as v from 'valibot'
import { NonNegativeInteger, NonEmptyString, parseValue } from '../validation'
import { Cookie, CookieJar } from 'tough-cookie'
import { AcquisitionSession } from './client'
import { AcquisitionError } from './parser'

export const CookieJarSchema = v.looseObject({
  version: v.string(),
  storeType: v.nullable(v.string()),
  rejectPublicSuffixes: v.boolean(),
  cookies: v.array(v.looseObject({ key: v.optional(v.string()), value: v.optional(v.string()) })),
})
const SessionKey = v.pipe(v.string(), v.regex(/^\d{4}\/(grass|hard)$/))
const FacilitySchema = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)), name: NonEmptyString })
export const SessionFields = {
  cookieJar: CookieJarSchema,
  initialized: v.boolean(),
  prepared: v.pipe(
    v.array(SessionKey),
    v.check((keys) => new Set(keys).size === keys.length),
  ),
  targets: v.pipe(
    v.array(
      v.object({
        key: SessionKey,
        parkName: v.string(),
        facilities: v.pipe(
          v.array(FacilitySchema),
          v.minLength(1),
          v.maxLength(4),
          v.check((fs) => new Set(fs.map((f) => f.id)).size === fs.length),
        ),
      }),
    ),
    v.maxLength(31),
    v.check((ts) => new Set(ts.map((t) => t.key)).size === ts.length),
  ),
}
const SessionStateSchema = v.object({
  ...SessionFields,
  initializationRetryAt: NonNegativeInteger,
  initializationError: v.string(),
})
export type SessionState = v.InferOutput<typeof SessionStateSchema>
function fail(): never {
  throw new AcquisitionError('session-recovery-required')
}
export function serializeSession(state: AcquisitionSession): SessionState {
  return {
    cookieJar: parseValue(
      CookieJarSchema,
      JSON.parse(JSON.stringify(state.jar.serializeSync())),
      () => new AcquisitionError('session-recovery-required'),
    ),
    initialized: state.initialized,
    prepared: [...state.prepared],
    targets: [...state.targets].map(([key, value]) => ({ key, ...value })),
    initializationRetryAt: state.initializationRetryAt,
    initializationError: state.initializationError,
  }
}
export function parseSessionState(input: unknown): SessionState {
  return parseValue(
    SessionStateSchema,
    input,
    () => new AcquisitionError('session-recovery-required'),
  )
}
export function restoreSession(value: SessionState, now = new Date()) {
  try {
    if (value.cookieJar.version !== new CookieJar().serializeSync()!.version) return fail()
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
