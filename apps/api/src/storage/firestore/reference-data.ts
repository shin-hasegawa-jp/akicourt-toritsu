import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Firestore, Timestamp, Transaction } from '@google-cloud/firestore'
import { CookieJar } from 'tough-cookie'
import parks from '../park-options'
import calendar from '../holiday-calendar'
import { HOLIDAY_SOURCE, validateCalendar } from '../holidays'

export type Park = { parkId: string; surface: 'grass' | 'hard'; name: string }
type ReferenceSource = { parks: readonly Park[]; calendar: unknown; years: number[] }
const bundled: ReferenceSource = {
  parks,
  calendar,
  years: calendar.years.map((entry) => entry.year),
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const schema = (value: Record<string, unknown> | undefined) => value?.schemaVersion === 1
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

function referenceBundle(source: ReferenceSource) {
  if (
    !source.parks.length ||
    source.parks.length > 100 ||
    new Set(source.parks.map((p) => `${p.parkId}_${p.surface}`)).size !== source.parks.length ||
    source.parks.some(
      (p) =>
        !/^\d{4}$/.test(p.parkId) ||
        !['grass', 'hard'].includes(p.surface) ||
        typeof p.name !== 'string' ||
        !p.name.trim(),
    )
  )
    throw new Error('invalid-park-catalog')
  const years = validateCalendar(source.calendar, source.years)
  const verifiedAt = (source.calendar as { verifiedAt: string }).verifiedAt
  const normalized = source.parks.map((p, officialOrder) => ({
    schemaVersion: 1,
    parkId: p.parkId,
    surface: p.surface,
    name: p.name,
    enabled: true,
    officialOrder,
  }))
  const version = hash({ parks: normalized, years, source: HOLIDAY_SOURCE, verifiedAt })
  const parkDocuments = normalized.map((p) => ({ ...p, version }))
  const holidayDocuments = years.map((y) => ({
    schemaVersion: 1,
    year: y.year,
    source: HOLIDAY_SOURCE,
    verifiedAt,
    count: y.count,
    checksum: y.sha256,
    holidays: y.holidays,
    version,
  }))
  const manifest = {
    schemaVersion: 1,
    activeVersion: version,
    parkIds: parkDocuments.map((p) => `${p.parkId}_${p.surface}`),
    years: years.map((y) => y.year),
  }
  return { manifest, parkDocuments, holidayDocuments }
}

export class ReferenceRepository {
  constructor(private readonly db: Firestore) {}

  private async state(tx: Transaction) {
    const refs = [
      this.db.doc('control/acquisition'),
      this.db.doc('control/queueCapacity'),
      this.db.doc('officialSessions/current'),
    ]
    const docs = await tx.getAll(...refs)
    if (docs.every((d) => !d.exists)) {
      const remnants = await Promise.all(
        ['parkSurfaces', 'holidayYears', 'jobs', 'scopes', 'snapshots', 'usage'].map((name) =>
          tx.get(this.db.collection(name).limit(1)),
        ),
      )
      const reference = await tx.get(this.db.doc('control/referenceData'))
      if (reference.exists || remnants.some((r) => !r.empty))
        throw new Error('inconsistent-initialization')
      return { refs, empty: true as const }
    }
    const [control, queue, session] = docs.map((d) => d.data())
    if (
      !docs.every((d) => d.exists && schema(d.data())) ||
      !control ||
      !queue ||
      !session ||
      typeof control?.updatesEnabled !== 'boolean' ||
      !(control.blockedReason === null || typeof control.blockedReason === 'string') ||
      !(control.owner === null || typeof control.owner === 'string') ||
      !(control.leaseUntil === null || control.leaseUntil instanceof Timestamp) ||
      !(control.nextRequestNotBefore instanceof Timestamp) ||
      !integer(control.fence) ||
      !integer(control.recoveryGeneration) ||
      !integer(queue?.pendingJobCount) ||
      !integer(session?.sessionGeneration) ||
      !integer(session?.revision) ||
      typeof session?.initialized !== 'boolean' ||
      !Array.isArray(session.prepared) ||
      !Array.isArray(session.targets) ||
      !['usable', 'recovery_required', 'disabled'].includes(session.restorationState) ||
      !(session.lastUsedAt === null || session.lastUsedAt instanceof Timestamp) ||
      !session.cookieJar
    )
      throw new Error('inconsistent-initialization')
    CookieJar.deserializeSync(session.cookieJar)
    return { refs, empty: false as const, control, queue, session }
  }

  async initialize(apply = false) {
    return this.db.runTransaction(
      async (tx) => {
        const state = await this.state(tx)
        if (!state.empty) return { action: 'initialize', changed: false, applied: false }
        if (apply) {
          tx.create(state.refs[0], {
            schemaVersion: 1,
            updatesEnabled: false,
            blockedReason: null,
            owner: null,
            leaseUntil: null,
            fence: 0,
            nextRequestNotBefore: Timestamp.fromMillis(0),
            recoveryGeneration: 1,
          })
          tx.create(state.refs[1], { schemaVersion: 1, pendingJobCount: 0 })
          tx.create(state.refs[2], {
            schemaVersion: 1,
            cookieJar: new CookieJar().serializeSync(),
            initialized: false,
            prepared: [],
            targets: [],
            initializationRetryAt: Timestamp.fromMillis(0),
            initializationError: null,
            sessionGeneration: 1,
            revision: 0,
            lastUsedAt: null,
            inFlight: null,
            restorationState: 'usable',
          })
        }
        return { action: 'initialize', changed: true, applied: apply }
      },
      { maxAttempts: 3 },
    )
  }

  async seed(apply = false, source: ReferenceSource = bundled) {
    // Validation precedes every DB operation; a truncated calendar cannot be published.
    const bundle = referenceBundle(source)
    return this.db.runTransaction(
      async (tx) => {
        const state = await this.state(tx)
        if (state.empty) throw new Error('storage-not-initialized')
        if (apply && (state.control.updatesEnabled || state.control.owner !== null))
          throw new Error('acquisition-must-be-stopped')
        const previous = await tx.get(this.db.doc('control/referenceData'))
        const oldParks = await tx.get(this.db.collection('parkSurfaces'))
        const oldYears = await tx.get(this.db.collection('holidayYears'))
        const expected = new Map(bundle.parkDocuments.map((p) => [`${p.parkId}_${p.surface}`, p]))
        const holidays = new Map(bundle.holidayDocuments.map((y) => [String(y.year), y]))
        const changed =
          !isDeepStrictEqual(previous.data(), bundle.manifest) ||
          bundle.parkDocuments.some(
            (p) =>
              !isDeepStrictEqual(
                oldParks.docs.find((d) => d.id === `${p.parkId}_${p.surface}`)?.data(),
                p,
              ),
          ) ||
          oldParks.docs.some(
            (d) =>
              !expected.has(d.id) &&
              (d.data().enabled !== false || d.data().version !== bundle.manifest.activeVersion),
          ) ||
          oldYears.size !== holidays.size ||
          oldYears.docs.some((d) => !isDeepStrictEqual(d.data(), holidays.get(d.id)))
        if (apply && changed) {
          for (const [id, park] of expected) tx.set(this.db.doc(`parkSurfaces/${id}`), park)
          for (const park of oldParks.docs)
            if (!expected.has(park.id))
              tx.update(park.ref, { enabled: false, version: bundle.manifest.activeVersion })
          for (const old of oldYears.docs) if (!holidays.has(old.id)) tx.delete(old.ref)
          for (const [year, data] of holidays) tx.set(this.db.doc(`holidayYears/${year}`), data)
          tx.set(this.db.doc('control/referenceData'), bundle.manifest)
        }
        return {
          action: 'seed-reference-data',
          changed,
          applied: apply && changed,
          version: bundle.manifest.activeVersion,
          parks: expected.size,
          years: bundle.manifest.years,
        }
      },
      { maxAttempts: 3 },
    )
  }

  async read() {
    return this.db.runTransaction(
      async (tx) => {
        const manifest = (await tx.get(this.db.doc('control/referenceData'))).data()
        if (!manifest) throw new Error('reference-data-not-initialized')
        const parkRows = await tx.get(this.db.collection('parkSurfaces'))
        const holidayRows = await tx.get(this.db.collection('holidayYears'))
        if (!schema(manifest) || !Array.isArray(manifest.parkIds) || !Array.isArray(manifest.years))
          throw new Error('inconsistent-reference-data')
        const active = parkRows.docs
          .filter((p) => p.data().enabled === true)
          .map((p) => p.data())
          .sort((a, b) => a.officialOrder - b.officialOrder)
        const years = holidayRows.docs.map((y) => y.data()).sort((a, b) => a.year - b.year)
        const bundle = referenceBundle({
          parks: active as Park[],
          years: manifest.years,
          calendar: {
            source: years[0]?.source,
            verifiedAt: years[0]?.verifiedAt,
            years: years.map((y) => ({ ...y, sha256: y.checksum })),
          },
        })
        if (
          !isDeepStrictEqual(manifest, bundle.manifest) ||
          !isDeepStrictEqual(active, bundle.parkDocuments) ||
          !isDeepStrictEqual(years, bundle.holidayDocuments) ||
          active.some(
            (p) =>
              !parkRows.docs.some(
                (d) => d.id === `${p.parkId}_${p.surface}` && isDeepStrictEqual(d.data(), p),
              ),
          ) ||
          years.some((y) => !holidayRows.docs.some((d) => d.id === String(y.year)))
        )
          throw new Error('inconsistent-reference-data')
        return {
          version: bundle.manifest.activeVersion,
          parks: active as typeof bundle.parkDocuments,
          years: bundle.holidayDocuments,
        }
      },
      { readOnly: true },
    )
  }

  async status() {
    return this.db.runTransaction(
      async (tx) => {
        const state = await this.state(tx)
        if (state.empty) return { initialized: false }
        // Never return the CookieJar, prepared target names, owner, or raw DTO.
        return {
          initialized: true,
          updatesEnabled: state.control.updatesEnabled,
          blockedReason: state.control.blockedReason,
          pendingJobCount: state.queue.pendingJobCount,
          sessionGeneration: state.session.sessionGeneration,
          sessionRevision: state.session.revision,
          restorationState: state.session.restorationState,
          lastUsedAt: state.session.lastUsedAt?.toDate().toISOString() ?? null,
        }
      },
      { readOnly: true },
    )
  }
}
