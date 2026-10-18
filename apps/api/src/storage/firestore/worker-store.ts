import * as v from 'valibot'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp, Transaction } from '@google-cloud/firestore'
import { AcquisitionError } from '../../availability/parser'
import { Result } from '../../availability/client'
import { NonNegativeInteger, TargetSchema, parseValue } from '../../validation'
import {
  AdmissionScopeSchema,
  ControlSchema,
  DispatchSchema,
  ParkDocumentSchema,
  SessionDocumentSchema,
  TimestampSchema,
} from './schemas'
import { JobRepository, DispatchJob } from './jobs'
import { SnapshotRepository } from './snapshots'
import { scopeId } from './snapshot-codec'

const RuntimeJob = v.looseObject({
  ...DispatchSchema.entries,
  scopeId: v.string(),
  target: TargetSchema,
  owner: v.nullable(v.string()),
  fence: v.nullable(NonNegativeInteger),
  leaseUntil: v.nullable(TimestampSchema),
  capacityReserved: v.boolean(),
})
export type Claim = DispatchJob & {
  owner: string
  fence: number
  target: v.InferOutput<typeof TargetSchema>
  parkName: string
}
const invalid = () => new Error('invalid-worker-storage')
const fail = (kind: string): never => {
  throw new AcquisitionError(kind)
}
const terminal = (state: string) => state === 'succeeded' || state === 'failed'
const cooldownMs = 900000

export class WorkerStore {
  readonly snapshots: SnapshotRepository
  constructor(
    private readonly db: Firestore,
    projectId: string,
    private readonly now = () => new Date(),
  ) {
    this.snapshots = new SnapshotRepository(db, projectId)
  }
  private async read(tx: Transaction, task: DispatchJob) {
    const ref = this.db.doc(`jobs/${task.jobId}`)
    const doc = await tx.get(ref)
    return { ref, job: doc.exists ? parseValue(RuntimeJob, doc.data(), invalid) : null }
  }
  private assertOwned(
    claim: Claim,
    job: v.InferOutput<typeof RuntimeJob> | null,
    control: v.InferOutput<typeof ControlSchema>,
    now: Date,
  ) {
    if (
      !job ||
      job.generation !== claim.generation ||
      control.recoveryGeneration !== claim.generation ||
      job.state !== 'running' ||
      job.owner !== claim.owner ||
      job.fence !== claim.fence ||
      control.owner !== claim.owner ||
      control.fence !== claim.fence ||
      !job.leaseUntil ||
      !control.leaseUntil ||
      job.leaseUntil.toMillis() <= now.getTime() ||
      control.leaseUntil.toMillis() <= now.getTime()
    )
      fail('ownership-lost')
  }
  private async endQueued(
    tx: Transaction,
    task: DispatchJob,
    scope: FirebaseFirestore.DocumentReference,
    errorCode: string,
  ) {
    const release = await new JobRepository(this.db).prepareCapacityRelease(tx, task.jobId)
    const until = Timestamp.fromMillis(this.now().getTime() + cooldownMs)
    release()
    tx.update(this.db.doc(`jobs/${task.jobId}`), {
      state: 'failed',
      errorCode,
      completedAt: Timestamp.fromDate(this.now()),
      cooldownUntil: until,
      leaseUntil: null,
    })
    tx.update(scope, { cooldownUntil: until })
  }
  async claim(task: DispatchJob): Promise<Claim | null> {
    const owner = randomUUID()
    const result = await this.db.runTransaction(
      async (tx) => {
        const { job } = await this.read(tx, task)
        // Old/terminal/missing deliveries never read or touch the official session.
        if (!job || job.generation !== task.generation || terminal(job.state))
          return { claim: null }
        const now = this.now()
        const controlRef = this.db.doc('control/acquisition'),
          scopeRef = this.db.doc(`scopes/${job.scopeId}`)
        const [controlDoc, scopeDoc] = await tx.getAll(controlRef, scopeRef)
        const control = parseValue(ControlSchema, controlDoc.data(), invalid)
        const scope = parseValue(AdmissionScopeSchema, scopeDoc.data(), invalid)
        if (job.generation !== control.recoveryGeneration) return { claim: null }
        if (scopeId(job.target) !== job.scopeId || scope.latestJobId !== task.jobId) throw invalid()
        if (job.state === 'running') {
          if (
            (job.leaseUntil && job.leaseUntil.toMillis() > now.getTime()) ||
            (control.leaseUntil && control.leaseUntil.toMillis() > now.getTime())
          )
            return { busy: true }
          // Never take over an expired worker automatically: an official request may still be running.
          if (
            !job.owner ||
            job.fence === null ||
            control.owner !== job.owner ||
            control.fence !== job.fence
          )
            return { busy: true }
          const release = await new JobRepository(this.db).prepareCapacityRelease(tx, task.jobId)
          const sessionRef = this.db.doc('officialSessions/current')
          const sessionDoc = await tx.get(sessionRef)
          release()
          const until = Timestamp.fromMillis(now.getTime() + cooldownMs)
          tx.update(this.db.doc(`jobs/${task.jobId}`), {
            state: 'failed',
            errorCode: 'interrupted',
            completedAt: Timestamp.fromDate(now),
            cooldownUntil: until,
            leaseUntil: null,
          })
          tx.update(scopeRef, { cooldownUntil: until })
          tx.update(controlRef, {
            owner: null,
            leaseUntil: null,
            fence: control.fence + 1,
            updatesEnabled: false,
            blockedReason: control.blockedReason ?? 'session-recovery-required',
            nextRequestNotBefore: until,
          })
          if (sessionDoc.exists) tx.update(sessionRef, { restorationState: 'recovery_required' })
          return { claim: null }
        }
        if (!control.updatesEnabled) {
          await this.endQueued(tx, task, scopeRef, control.blockedReason ?? 'updates_disabled')
          return { claim: null }
        }
        if (control.owner !== null || control.leaseUntil !== null) return { busy: true }
        const [sessionDoc, parkDoc] = await tx.getAll(
          this.db.doc('officialSessions/current'),
          this.db.doc(`parkSurfaces/${job.target.parkId}_${job.target.surface}`),
        )
        const session = v.safeParse(SessionDocumentSchema, sessionDoc.data())
        if (
          !session.success ||
          session.output.restorationState !== 'usable' ||
          session.output.inFlight !== null
        ) {
          const release = await new JobRepository(this.db).prepareCapacityRelease(tx, task.jobId)
          release()
          const until = Timestamp.fromMillis(now.getTime() + cooldownMs)
          tx.update(this.db.doc(`jobs/${task.jobId}`), {
            state: 'failed',
            errorCode: 'session_recovery_required',
            completedAt: Timestamp.fromDate(now),
            cooldownUntil: until,
          })
          tx.update(scopeRef, { cooldownUntil: until })
          tx.update(controlRef, {
            updatesEnabled: false,
            blockedReason: 'session-recovery-required',
          })
          if (sessionDoc.exists)
            tx.update(sessionDoc.ref, { restorationState: 'recovery_required' })
          return { claim: null }
        }
        const park = parseValue(ParkDocumentSchema, parkDoc.data(), invalid)
        if (!park.enabled) {
          await this.endQueued(tx, task, scopeRef, 'unsupported-target')
          return { claim: null }
        }
        const fence = control.fence + 1,
          leaseUntil = Timestamp.fromMillis(now.getTime() + 90000)
        tx.update(controlRef, { owner, fence, leaseUntil })
        tx.update(this.db.doc(`jobs/${task.jobId}`), {
          state: 'running',
          owner,
          fence,
          leaseUntil,
          startedAt: Timestamp.fromDate(now),
          dispatchState: 'submitted',
        })
        return { claim: { ...task, owner, fence, target: job.target, parkName: park.name } }
      },
      { maxAttempts: 3 },
    )
    if ('busy' in result) fail('worker-busy')
    return result.claim ?? null
  }
  // Check only: the session checkpoint reserves the next HTTP slot atomically.
  async gate(claim: Claim) {
    return this.db.runTransaction(
      async (tx) => {
        const { job } = await this.read(tx, claim)
        const control = parseValue(
          ControlSchema,
          (await tx.get(this.db.doc('control/acquisition'))).data(),
          invalid,
        )
        const now = this.now()
        this.assertOwned(claim, job, control, now)
        if (!control.updatesEnabled) fail('updates-disabled')
        return Math.max(0, control.nextRequestNotBefore.toMillis() - now.getTime())
      },
      { readOnly: true },
    )
  }
  async heartbeat(claim: Claim, requestCount?: number) {
    await this.db.runTransaction(
      async (tx) => {
        const { ref, job } = await this.read(tx, claim)
        const controlRef = this.db.doc('control/acquisition')
        const control = parseValue(ControlSchema, (await tx.get(controlRef)).data(), invalid)
        const now = this.now()
        this.assertOwned(claim, job, control, now)
        if (!control.updatesEnabled) fail('updates-disabled')
        const leaseUntil = Timestamp.fromMillis(now.getTime() + 90000)
        tx.update(controlRef, { leaseUntil })
        tx.update(ref, { leaseUntil, ...(requestCount === undefined ? {} : { requestCount }) })
      },
      { maxAttempts: 3 },
    )
  }
  async finish(claim: Claim, result: Result, snapshotId?: string) {
    if (scopeId(result.target) !== scopeId(claim.target)) throw invalid()
    await this.db.runTransaction(
      async (tx) => {
        const { ref, job } = await this.read(tx, claim)
        if (job && job.generation === claim.generation && terminal(job.state)) return
        const controlRef = this.db.doc('control/acquisition'),
          scopeRef = this.db.doc(`scopes/${scopeId(claim.target)}`),
          sessionRef = this.db.doc('officialSessions/current')
        const [controlDoc, scopeDoc, sessionDoc] = await tx.getAll(controlRef, scopeRef, sessionRef)
        const control = parseValue(ControlSchema, controlDoc.data(), invalid)
        const scope = parseValue(AdmissionScopeSchema, scopeDoc.data(), invalid)
        const session = parseValue(SessionDocumentSchema, sessionDoc.data(), invalid)
        const now = this.now()
        this.assertOwned(claim, job, control, now)
        if (scope.latestJobId !== claim.jobId) throw invalid()
        const release = await new JobRepository(this.db).prepareCapacityRelease(tx, claim.jobId)
        let errorCode = result.state === 'failed' ? result.error : null
        if (!control.updatesEnabled) errorCode = errorCode ?? 'updates_disabled'
        const uncertain =
          session.inFlight !== null ||
          session.restorationState !== 'usable' ||
          ['interrupted', 'session-checkpoint-failed', 'session-recovery-required'].includes(
            errorCode ?? '',
          )
        if (uncertain) errorCode = errorCode ?? 'session-recovery-required'
        if (!errorCode) {
          if (!snapshotId) throw invalid()
          await this.snapshots.publish(tx, snapshotId, claim.target, scope.publicationGeneration)
        }
        release()
        const cooldownUntil = Timestamp.fromMillis(now.getTime() + cooldownMs)
        tx.update(ref, {
          state: errorCode ? 'failed' : 'succeeded',
          errorCode,
          completedAt: Timestamp.fromDate(now),
          cooldownUntil,
          leaseUntil: null,
          requestCount: result.requests.length,
        })
        tx.update(scopeRef, { cooldownUntil })
        tx.update(controlRef, {
          owner: null,
          leaseUntil: null,
          ...(uncertain
            ? {
                updatesEnabled: false,
                blockedReason: control.blockedReason ?? 'session-recovery-required',
              }
            : {}),
        })
        if (uncertain) tx.update(sessionRef, { restorationState: 'recovery_required' })
      },
      { maxAttempts: 3 },
    )
  }
}
