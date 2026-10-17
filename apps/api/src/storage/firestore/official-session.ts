import { parseValue } from '../../validation'
import { ControlSchema, SessionDocumentSchema } from './schemas'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { AcquisitionSession, SessionCheckpoint } from '../../availability/client'
import { AcquisitionError } from '../../availability/parser'
import { restoreSession, serializeSession } from '../../availability/session-state'
import { limits, measureDocument } from './snapshot-codec'

type Ownership = { owner: string; fence: number }
function fail(kind = 'session-recovery-required'): never {
  throw new AcquisitionError(kind)
}
function owned(control: unknown, ownership: Ownership, now: Date) {
  const valid = parseValue(ControlSchema, control, () => new AcquisitionError('ownership-lost'))
  if (
    !ownership.owner ||
    valid.owner !== ownership.owner ||
    valid.fence !== ownership.fence ||
    !valid.leaseUntil ||
    valid.leaseUntil.toMillis() <= now.getTime()
  )
    fail('ownership-lost')
  return valid
}

// Requires an already claimed global lease. Claim/heartbeat/job finalization are FS-2c.
export class OfficialSessionRepository {
  constructor(
    private readonly db: Firestore,
    private readonly projectId: string,
    private readonly now = () => new Date(),
  ) {}

  async load(ownership: Ownership) {
    const ref = this.db.doc('officialSessions/current')
    const loaded = await this.db.runTransaction(
      async (tx) => {
        const [controlDoc, doc] = await tx.getAll(this.db.doc('control/acquisition'), ref)
        const now = this.now(),
          control = owned(controlDoc.data(), ownership, now),
          data = doc.data()
        if (!control.updatesEnabled || control.blockedReason !== null) fail('updates-disabled')
        try {
          const saved = parseValue(
            SessionDocumentSchema,
            data,
            () => new AcquisitionError('session-recovery-required'),
          )
          if (saved.restorationState !== 'usable' || saved.inFlight !== null) fail()
          const state = restoreSession(
            {
              ...saved,
              initializationRetryAt: saved.initializationRetryAt.toMillis(),
              initializationError: saved.initializationError ?? 'invalid-home',
            },
            now,
          )
          return {
            state,
            revision: saved.revision,
            generation: saved.sessionGeneration,
          }
        } catch {
          if (data && data.restorationState !== 'disabled')
            tx.update(ref, { restorationState: 'recovery_required' })
          return null
        }
      },
      { maxAttempts: 3 },
    )
    if (!loaded) return fail()
    let revision = loaded.revision,
      generation = loaded.generation
    const checkpoint = async (state: AcquisitionSession, event: SessionCheckpoint) => {
      const requestId = randomUUID()
      const result = await this.db.runTransaction(
        async (tx) => {
          const [controlDoc, doc] = await tx.getAll(this.db.doc('control/acquisition'), ref)
          const now = this.now(),
            control = owned(controlDoc.data(), ownership, now),
            data = parseValue(
              SessionDocumentSchema,
              doc.data(),
              () => new AcquisitionError('session-recovery-required'),
            )
          if (
            data.revision !== revision ||
            data.sessionGeneration !== generation ||
            data.restorationState !== 'usable'
          )
            fail()
          if (event.kind === 'before-request') {
            if (!control.updatesEnabled || control.blockedReason !== null) fail('updates-disabled')
            if (data.inFlight !== null) fail()
            if (control.nextRequestNotBefore.toMillis() > now.getTime()) fail('request-too-soon')
          } else if (
            data.inFlight &&
            (data.inFlight.owner !== ownership.owner || data.inFlight.fence !== ownership.fence)
          )
            fail('ownership-lost')
          const serialized = serializeSession(state)
          const uncertain = event.kind === 'response' && event.uncertain
          const nextGeneration = generation + (event.kind === 'state' && event.reset ? 1 : 0)
          const next = {
            ...data,
            ...serialized,
            schemaVersion: 1,
            sessionGeneration: nextGeneration,
            revision: revision + 1,
            initializationRetryAt: Timestamp.fromMillis(serialized.initializationRetryAt),
            lastUsedAt: Timestamp.fromDate(now),
            restorationState: uncertain ? 'recovery_required' : 'usable',
            inFlight:
              event.kind === 'before-request'
                ? {
                    owner: ownership.owner,
                    fence: ownership.fence,
                    requestId,
                    startedAt: Timestamp.fromDate(now),
                    phase: 'sent',
                  }
                : event.kind === 'response' && (!event.error || uncertain)
                  ? { ...data.inFlight, phase: uncertain ? 'uncertain' : 'received' }
                  : null,
          }
          const size = measureDocument(
            `projects/${this.projectId}/databases/${this.db.databaseId}/documents/${ref.path}`,
            next,
          )
          if (size.documentBytes > limits.documentBytes || size.wireBytes > limits.documentBytes)
            fail('session-capacity-exceeded')
          tx.set(ref, next)
          if (event.kind === 'before-request')
            tx.update(controlDoc.ref, {
              nextRequestNotBefore: Timestamp.fromMillis(now.getTime() + 2000),
            })
          if (event.kind === 'response' && event.error === 'access-blocked')
            tx.update(controlDoc.ref, { blockedReason: 'access-blocked' })
          return { revision: next.revision, generation: nextGeneration, uncertain }
        },
        { maxAttempts: 3 },
      )
      revision = result.revision
      generation = result.generation
      if (result.uncertain) fail()
    }
    return { state: loaded.state, checkpoint }
  }
}
