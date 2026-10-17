import { CalendarSchema, yearSchema } from '../holidays'
import * as v from 'valibot'
import { Timestamp } from '@google-cloud/firestore'
import { SessionFields } from '../../availability/session-state'
import {
  Id,
  NonNegativeInteger,
  NonEmptyString,
  ParkId,
  Surface,
  DateString,
  Clock,
  PositiveInteger,
  TargetSchema,
} from '../../validation'

export const Versioned = v.looseObject({ schemaVersion: v.literal(1) })
export const TimestampSchema = v.instance(Timestamp)
export const ControlSchema = v.looseObject({
  ...Versioned.entries,
  updatesEnabled: v.boolean(),
  blockedReason: v.nullable(v.string()),
  owner: v.nullable(v.string()),
  leaseUntil: v.nullable(TimestampSchema),
  fence: NonNegativeInteger,
  nextRequestNotBefore: TimestampSchema,
  recoveryGeneration: NonNegativeInteger,
})
export const QueueSchema = v.looseObject({
  ...Versioned.entries,
  pendingJobCount: NonNegativeInteger,
})
export const UsageSchema = v.looseObject({ ...Versioned.entries, newJobCount: NonNegativeInteger })
export const SessionDocumentSchema = v.looseObject({
  ...Versioned.entries,
  ...SessionFields,
  sessionGeneration: NonNegativeInteger,
  revision: NonNegativeInteger,
  initializationRetryAt: TimestampSchema,
  initializationError: v.nullable(v.string()),
  lastUsedAt: v.nullable(TimestampSchema),
  restorationState: v.picklist(['usable', 'recovery_required', 'disabled']),
  // Any remaining marker blocks restoration. Its detailed protocol is owned by the worker.
  inFlight: v.nullable(v.record(v.string(), v.unknown())),
})
export const ScopeSchema = v.looseObject({
  ...Versioned.entries,
  parkId: ParkId,
  surface: Surface,
  weekStart: DateString,
  latestSnapshotId: v.nullable(Id),
  publicationGeneration: NonNegativeInteger,
  latestJobId: v.optional(v.nullable(Id)),
  observedAt: v.optional(v.nullable(TimestampSchema)),
})
export const AdmissionScopeSchema = v.looseObject({
  ...ScopeSchema.entries,
  cooldownUntil: TimestampSchema,
})
const JobState = v.picklist(['queued', 'running', 'succeeded', 'failed'])
export const AttemptSchema = v.pipe(
  v.looseObject({
    ...Versioned.entries,
    scopeId: v.string(),
    state: JobState,
    errorCode: v.nullable(v.string()),
    dispatchState: v.picklist(['pending', 'submitted', 'recovery_required']),
    queuedAt: TimestampSchema,
    leaseUntil: v.optional(v.nullable(TimestampSchema)),
  }),
  v.check((j) => j.state !== 'running' || j.leaseUntil != null),
)
export const AdmissionJobSchema = v.pipe(
  v.looseObject({
    ...Versioned.entries,
    scopeId: v.string(),
    state: JobState,
    generation: NonNegativeInteger,
    cooldownUntil: TimestampSchema,
    capacityReserved: v.boolean(),
  }),
  v.check((j) => j.capacityReserved === ['queued', 'running'].includes(j.state)),
)
export const ReservationSchema = v.looseObject({
  ...Versioned.entries,
  state: JobState,
  capacityReserved: v.boolean(),
})
export const ParkSchema = v.object({ parkId: ParkId, surface: Surface, name: NonEmptyString })
export const ParkDocumentSchema = v.looseObject({
  ...Versioned.entries,
  ...ParkSchema.entries,
  enabled: v.boolean(),
  officialOrder: NonNegativeInteger,
  version: v.string(),
})
export const ReferenceSchema = v.looseObject({
  ...Versioned.entries,
  activeVersion: v.string(),
  parkIds: v.array(v.string()),
  years: v.array(yearSchema),
})
export const StoredSlotSchema = v.looseObject({
  facilityId: Id,
  date: DateString,
  start: Clock,
  end: Clock,
  availableCourts: PositiveInteger,
})
export const SnapshotFacilitySchema = v.looseObject({
  id: Id,
  name: NonEmptyString,
  checkedCells: PositiveInteger,
})
export const SnapshotSchema = v.looseObject({
  ...Versioned.entries,
  scopeId: v.string(),
  target: TargetSchema,
  attemptedAt: TimestampSchema,
  completedAt: TimestampSchema,
  facilities: v.pipe(v.array(SnapshotFacilitySchema), v.minLength(1)),
  payload: v.array(StoredSlotSchema),
  slotCount: NonNegativeInteger,
  checksum: v.string(),
})

export const DispatchSchema = v.looseObject({
  ...Versioned.entries,
  generation: NonNegativeInteger,
  state: JobState,
  dispatchState: v.picklist(['pending', 'submitted', 'recovery_required']),
})

export const HolidayDocumentSchema = v.looseObject({
  ...Versioned.entries,
  year: yearSchema,
  source: CalendarSchema.entries.source,
  verifiedAt: CalendarSchema.entries.verifiedAt,
  holidays: CalendarSchema.entries.years.item.entries.holidays,
  count: v.number(),
  checksum: v.string(),
  version: v.string(),
})
