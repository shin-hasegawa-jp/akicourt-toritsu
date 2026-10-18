import * as v from 'valibot'
import { PositiveInteger, parseValue } from '../../validation'
import { ScopeSchema, AttemptSchema } from './schemas'
import { DocumentSnapshot, Firestore } from '@google-cloud/firestore'
import { ApiError, Input, resolveInput } from '../../availability-api/input'
import { ReferenceRepository } from './reference-data'
import { SnapshotRepository } from './snapshots'
import { jsonBytes, limits, measureDocument, scopeId } from './snapshot-codec'

type OutputSlot = {
  parkId: string
  parkName: string
  surface: string
  facilityId: string
  facilityName: string
  date: string
  start: string
  end: string
  availableCourts: number
  snapshotId: string
  observedAt: string
}
type Attempt = {
  jobId: string
  state: string
  errorCode: string | null
  dispatchState: string
  recoveryRequired: boolean
}
type OutputScope = {
  parkId: string
  surface: string
  weekStart: string
  dataState: 'fresh' | 'stale' | 'unavailable'
  snapshotId: string | null
  lastSuccessAt: string | null
  latestAttempt: Attempt | null
}
const unavailable = () => new ApiError(503, 'storage_unavailable', '保存済み情報を利用できません。')
const capacity = () =>
  new ApiError(503, 'search_capacity_exceeded', '検索データが読取上限を超えています。')
export class FirestoreSearch {
  constructor(
    private readonly db: Firestore,
    private readonly projectId: string,
    private readonly onRead?: (metrics: {
      documentReads: number
      wireBytes: number
      elapsedMs: number
    }) => void,
    private readonly maxReadBytes = limits.searchBytes,
  ) {
    if (!v.is(PositiveInteger, maxReadBytes) || maxReadBytes > limits.searchBytes)
      throw new Error('invalid-read-budget')
  }
  async search(input: Input, now = new Date(), query = resolveInput(input)) {
    const minute = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))
    const started = performance.now()
    let statistics = { documentReads: 0, wireBytes: 0 }
    try {
      const result = await this.db.runTransaction(
        async (tx) => {
          statistics = { documentReads: 0, wireBytes: 0 }
          const observe = (document: DocumentSnapshot) => {
            statistics.documentReads++
            statistics.wireBytes += measureDocument(
              `projects/${this.projectId}/databases/${this.db.databaseId}/documents/${document.ref.path}`,
              document.data() ?? {},
            ).wireBytes
            if (statistics.wireBytes > this.maxReadBytes) throw capacity()
          }
          const reference = await new ReferenceRepository(this.db).read(tx, observe)
          const holidays = new Set(reference.years.flatMap((y) => y.holidays.map((h) => h.date)))
          const holidayNeeded = query.includeHolidays && query.weekdays.length < 7
          const years = new Set([
            Number(query.dateFrom.slice(0, 4)),
            Number(query.dateTo.slice(0, 4)),
          ])
          if (
            holidayNeeded &&
            [...years].some((y) => !reference.years.some((entry) => entry.year === y))
          )
            throw new ApiError(
              503,
              'holiday_calendar_unavailable',
              '対象年の祝日情報が未登録です。',
            )
          const slots: OutputSlot[] = []
          let responseBytes = 0
          const output: OutputScope[] = []
          const snapshots = new SnapshotRepository(this.db, this.projectId)
          for (const target of query.targets) {
            const id = scopeId(target)
            const park = reference.parks.find(
              (p) => p.parkId === target.parkId && p.surface === target.surface,
            )
            if (!park) throw new ApiError(400, 'invalid_request', '未対応の公園・種目です。')
            const scopeDocument = await tx.get(this.db.doc(`scopes/${id}`))
            observe(scopeDocument)
            const scope = scopeDocument.exists
              ? parseValue(ScopeSchema, scopeDocument.data(), unavailable)
              : undefined
            if (
              scope &&
              (scope.parkId !== target.parkId ||
                scope.surface !== target.surface ||
                scope.weekStart !== target.startDate)
            )
              throw unavailable()
            let latestAttempt: Attempt | null = null
            if (scope?.latestJobId != null) {
              const jobDocument = await tx.get(this.db.doc(`jobs/${scope.latestJobId}`))
              observe(jobDocument)
              const job = parseValue(AttemptSchema, jobDocument.data(), unavailable)
              if (job.scopeId !== id) throw unavailable()
              latestAttempt = {
                jobId: scope.latestJobId,
                state: job.state,
                errorCode: job.errorCode,
                dispatchState: job.dispatchState,
                recoveryRequired:
                  ['queued', 'running'].includes(job.state) &&
                  (job.dispatchState === 'recovery_required' ||
                    (job.dispatchState === 'pending' &&
                      now.getTime() - job.queuedAt.toMillis() >= 120000) ||
                    (job.state === 'running' &&
                      (job.leaseUntil?.toMillis() ?? 0) <= now.getTime())),
              }
            }
            const snapshotId = scope?.latestSnapshotId ?? null
            let lastSuccessAt: string | null = null
            if (snapshotId) {
              const stored = await snapshots.read(tx, snapshotId, target, observe)
              if (!scope?.observedAt || !scope.observedAt.isEqual(stored.snapshot.completedAt))
                throw unavailable()
              lastSuccessAt = stored.snapshot.completedAt.toDate().toISOString()
              const facilities = new Map(stored.snapshot.facilities.map((f) => [f.id, f]))
              for (const slot of stored.slots) {
                const weekday = new Date(`${slot.date}T00:00:00Z`).getUTCDay()
                if (
                  slot.date < query.dateFrom ||
                  slot.date > query.dateTo ||
                  !(
                    query.weekdays.includes(weekday) ||
                    (holidayNeeded && holidays.has(slot.date))
                  ) ||
                  minute(slot.start) < query.timeFrom ||
                  minute(slot.end) > query.timeTo ||
                  minute(slot.end) - minute(slot.start) < query.minDurationMinutes
                )
                  continue
                const facility = facilities.get(slot.facilityId)!
                const outputSlot = {
                  ...slot,
                  parkId: target.parkId,
                  parkName: park.name,
                  surface: target.surface,
                  facilityName: facility.name,
                  snapshotId,
                  observedAt: lastSuccessAt,
                }
                responseBytes += jsonBytes(outputSlot)
                if (slots.length >= 10000 || responseBytes > limits.searchBytes)
                  throw new ApiError(503, 'response_too_large', '検索結果が上限を超えています。')
                slots.push(outputSlot)
              }
            }
            output.push({
              parkId: target.parkId,
              surface: target.surface,
              weekStart: target.startDate,
              dataState: !lastSuccessAt
                ? 'unavailable'
                : now.getTime() - Date.parse(lastSuccessAt) <= 900000
                  ? 'fresh'
                  : 'stale',
              snapshotId,
              lastSuccessAt,
              latestAttempt,
            })
          }
          slots.sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              a.start.localeCompare(b.start) ||
              a.parkId.localeCompare(b.parkId) ||
              a.facilityId.localeCompare(b.facilityId),
          )
          const available = output.filter((s) => s.snapshotId).length
          const response = {
            generatedAt: now.toISOString(),
            dateFrom: query.dateFrom,
            dateTo: query.dateTo,
            coverage: available === output.length ? 'complete' : available ? 'partial' : 'none',
            scopes: output,
            slots,
            officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
          }
          if (jsonBytes(response) > limits.searchBytes)
            throw new ApiError(503, 'response_too_large', '検索結果が上限を超えています。')
          return response
        },
        { readOnly: true },
      )
      this.onRead?.({ ...statistics, elapsedMs: performance.now() - started })
      return result
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw unavailable()
    }
  }
}
