import * as v from 'valibot'
import { NonNegativeInteger, PositiveInteger, parseValue } from '../../validation'
import {
  ControlSchema,
  QueueSchema,
  UsageSchema,
  AdmissionJobSchema,
  AdmissionScopeSchema,
  ReservationSchema,
  DispatchSchema,
  ParkDocumentSchema,
} from './schemas'
import { randomUUID } from 'node:crypto'
import { Firestore, Timestamp, Transaction } from '@google-cloud/firestore'
import { Target } from '../../availability/client'
import { ApiError } from '../../availability-api/input'
import { japanToday } from '../scopes'
import { scopeId, validId } from './snapshot-codec'

export type DispatchJob = { jobId: string; generation: number }
export class AdmissionError extends ApiError {
  constructor(
    code: string,
    readonly retryAfter: number,
  ) {
    super(429, code, '更新の受付上限に達しています。時間をおいて再試行してください。')
  }
}
const invalid = () => new Error('invalid-job-storage')
const active = (state: string) => state === 'queued' || state === 'running'

export class JobRepository {
  constructor(
    private readonly db: Firestore,
    private readonly now = () => new Date(),
    private readonly limits = { pending: 20, daily: 100 },
  ) {
    if (![limits.pending, limits.daily].every((n) => v.is(PositiveInteger, n)))
      throw new Error('invalid-job-limits')
  }

  async enqueue(targets: Target[]) {
    if (!targets.length || targets.length > 10) throw new Error('invalid-job-targets')
    const ids = targets.map(scopeId)
    if (new Set(ids).size !== ids.length) throw new Error('duplicate-job-targets')
    const newIds = targets.map(() => randomUUID())
    return this.db.runTransaction(
      async (tx) => {
        const now = this.now()
        const day = japanToday(now)
        const controlRef = this.db.doc('control/acquisition')
        const queueRef = this.db.doc('control/queueCapacity')
        const usageRef = this.db.doc(`usage/${day}`)
        const [controlDoc, queueDoc, usageDoc] = await tx.getAll(controlRef, queueRef, usageRef)
        const control = parseValue(ControlSchema, controlDoc.data(), invalid)
        const queue = parseValue(QueueSchema, queueDoc.data(), invalid)
        const usage = usageDoc.exists
          ? parseValue(UsageSchema, usageDoc.data(), invalid)
          : undefined
        if (!control.updatesEnabled || control.blockedReason !== null)
          throw new ApiError(503, 'worker_unavailable', '更新受付は停止しています。')
        const scopes = await tx.getAll(...ids.map((id) => this.db.doc(`scopes/${id}`)))
        const parks = await tx.getAll(
          ...targets.map((t) => this.db.doc(`parkSurfaces/${t.parkId}_${t.surface}`)),
        )
        const previous = await Promise.all(
          scopes.map(async (s) => {
            const id = s.data()?.latestJobId
            if (id == null) return undefined
            if (!validId(id)) throw invalid()
            const doc = await tx.get(this.db.doc(`jobs/${id}`))
            const job = parseValue(AdmissionJobSchema, doc.data(), invalid)
            if (job.scopeId !== s.id) throw invalid()
            return {
              jobId: id,
              state: job.state,
              generation: job.generation,
              cooldownUntil: job.cooldownUntil,
            }
          }),
        )
        let created = 0
        const results = targets.map((target, i) => {
          const park = parseValue(
              ParkDocumentSchema,
              parks[i].data(),
              () => new ApiError(400, 'invalid_request', '未対応の公園・種目です。'),
            ),
            scope = scopes[i].exists
              ? parseValue(AdmissionScopeSchema, scopes[i].data(), invalid)
              : undefined,
            old = previous[i]
          if (
            park.enabled !== true ||
            park.parkId !== target.parkId ||
            park.surface !== target.surface
          )
            throw new ApiError(400, 'invalid_request', '未対応の公園・種目です。')
          if (
            scope &&
            (scope.parkId !== target.parkId ||
              scope.surface !== target.surface ||
              scope.weekStart !== target.startDate)
          )
            throw invalid()
          if (old && (active(old.state) || old.cooldownUntil.toMillis() > now.getTime()))
            return { jobId: old.jobId, generation: old.generation, reused: true }
          if (scope && scope.cooldownUntil.toMillis() > now.getTime()) throw invalid()
          created++
          return {
            jobId: newIds[i],
            generation: control.recoveryGeneration,
            reused: false,
          }
        })
        if (created && queue.pendingJobCount + created > this.limits.pending)
          throw new AdmissionError('queue_capacity_exceeded', 30)
        if (created && (usage?.newJobCount ?? 0) + created > this.limits.daily) {
          const midnight = Date.parse(`${day}T00:00:00+09:00`) + 86400000
          throw new AdmissionError(
            'daily_job_limit_exceeded',
            Math.ceil((midnight - now.getTime()) / 1000),
          )
        }
        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          if (result.reused) continue
          const target = targets[i]
          tx.create(this.db.doc(`jobs/${result.jobId}`), {
            schemaVersion: 1,
            scopeId: ids[i],
            target,
            generation: result.generation,
            state: 'queued',
            dispatchState: 'pending',
            queuedAt: Timestamp.fromDate(now),
            startedAt: null,
            completedAt: null,
            errorCode: null,
            requestCount: 0,
            cooldownUntil: Timestamp.fromMillis(0),
            owner: null,
            fence: null,
            leaseUntil: null,
            capacityReserved: true,
          })
          tx.set(
            scopes[i].ref,
            {
              ...(!scopes[i].exists
                ? {
                    schemaVersion: 1,
                    parkId: target.parkId,
                    surface: target.surface,
                    weekStart: target.startDate,
                    latestSnapshotId: null,
                    previousSnapshotId: null,
                    publicationGeneration: 0,
                    observedAt: null,
                  }
                : {}),
              latestJobId: result.jobId,
              cooldownUntil: Timestamp.fromMillis(0),
            },
            { merge: true },
          )
        }
        if (created) {
          tx.update(queueRef, { pendingJobCount: queue.pendingJobCount + created })
          tx.set(usageRef, { schemaVersion: 1, newJobCount: (usage?.newJobCount ?? 0) + created })
        }
        return results
      },
      { maxAttempts: 3 },
    )
  }

  async pending() {
    const documents = await this.db
      .collection('jobs')
      .where('dispatchState', '==', 'pending')
      .where('state', '==', 'queued')
      .limit(10)
      .get()
    return documents.docs.map((d) => {
      const generation: unknown = d.get('generation')
      if (!v.is(NonNegativeInteger, generation)) throw invalid()
      return { jobId: d.id, generation }
    })
  }

  async dispatchable(job: DispatchJob) {
    if (!validId(job.jobId) || !v.is(NonNegativeInteger, job.generation)) throw invalid()
    const data = parseValue(
      DispatchSchema,
      (await this.db.doc(`jobs/${job.jobId}`).get()).data(),
      invalid,
    )
    return (
      data.generation === job.generation &&
      data.state === 'queued' &&
      data.dispatchState === 'pending'
    )
  }

  async submitted(job: DispatchJob) {
    await this.db.runTransaction(
      async (tx) => {
        const ref = this.db.doc(`jobs/${job.jobId}`)
        const data = parseValue(DispatchSchema, (await tx.get(ref)).data(), invalid)
        if (
          data.generation === job.generation &&
          active(data.state) &&
          data.dispatchState === 'pending'
        )
          tx.update(ref, {
            dispatchState: 'submitted',
            submittedAt: Timestamp.fromDate(this.now()),
          })
      },
      { maxAttempts: 3 },
    )
  }

  // Internal transaction primitive: caller must verify owner/fence and finalize the job
  // in this SAME transaction. Read this before any writes, including snapshot publication.
  async prepareCapacityRelease(tx: Transaction, jobId: string) {
    const jobRef = this.db.doc(`jobs/${jobId}`),
      queueRef = this.db.doc('control/queueCapacity')
    const [jobDoc, queueDoc] = await tx.getAll(jobRef, queueRef)
    const job = parseValue(ReservationSchema, jobDoc.data(), invalid)
    const queue = parseValue(QueueSchema, queueDoc.data(), invalid)
    if (!job.capacityReserved) return () => undefined
    if (!active(job.state) || queue.pendingJobCount < 1) throw invalid()
    return () => {
      tx.update(queueRef, { pendingJobCount: queue.pendingJobCount - 1 })
      tx.update(jobRef, { capacityReserved: false })
    }
  }
}
