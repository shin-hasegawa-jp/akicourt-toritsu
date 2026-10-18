import * as v from 'valibot'
import { CookieJar } from 'tough-cookie'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { Id, NonNegativeInteger, parseValue } from '../../validation'
import { ControlSchema, TimestampSchema } from './schemas'
import { AdministrationError } from './administration'
import { QueueMaintenance } from './task-queue'

const Job = v.object({ state: v.picklist(['queued', 'running']), scopeId: Id })
const Metadata = v.object({
  sessionGeneration: NonNegativeInteger,
  revision: NonNegativeInteger,
})
const invalid = () => new AdministrationError('invalid-reset-control')

// Resets acquisition, not the database. Old task deliveries are fenced by generation.
export class AcquisitionReset {
  constructor(
    private readonly db: Firestore,
    private readonly queue: QueueMaintenance | null,
    private readonly now = () => new Date(),
  ) {}

  async run(options: { apply?: boolean; confirmWorkerStopped?: boolean } = {}) {
    if (options.apply && !options.confirmWorkerStopped)
      throw new AdministrationError('worker-stopped-confirmation-required')
    // Freeze before touching Cloud Tasks. If an external call or the final commit
    // fails, resume refuses the unusable DTO; rerunning reset is the recovery path.
    if (options.apply) {
      await this.db.runTransaction(
        async (tx) => {
          const ref = this.db.doc('control/acquisition'),
            sessionRef = this.db.doc('officialSessions/current')
          const [controlDoc, sessionDoc] = await tx.getAll(ref, sessionRef)
          const control = parseValue(ControlSchema, controlDoc.data(), invalid)
          tx.update(ref, {
            updatesEnabled: false,
            blockedReason: 'acquisition-reset',
            fence: control.fence + 1,
            nextRequestNotBefore: Timestamp.fromMillis(
              Math.max(control.nextRequestNotBefore.toMillis(), this.now().getTime() + 900000),
            ),
          })
          if (sessionDoc.exists) tx.update(sessionRef, { restorationState: 'recovery_required' })
        },
        { maxAttempts: 3 },
      )
      await this.queue?.pauseAndPurge()
    }
    return this.db.runTransaction(
      async (tx) => {
        const controlRef = this.db.doc('control/acquisition'),
          sessionRef = this.db.doc('officialSessions/current')
        const [controlDoc, sessionDoc] = await tx.getAll(controlRef, sessionRef)
        const control = parseValue(ControlSchema, controlDoc.data(), invalid)
        if (options.apply && control.updatesEnabled)
          throw new AdministrationError('reset-interrupted')
        const metadata = v.safeParse(Metadata, sessionDoc.data())
        const retryAt = v.safeParse(TimestampSchema, sessionDoc.get('initializationRetryAt'))
        let until = Timestamp.fromMillis(
          Math.max(
            control.nextRequestNotBefore.toMillis(),
            retryAt.success ? retryAt.output.toMillis() : 0,
            this.now().getTime() + 900000,
          ),
        )
        const rows = await tx.get(
          this.db
            .collection('jobs')
            .where('state', 'in', ['queued', 'running'])
            .select('state', 'scopeId')
            .limit(101),
        )
        if (rows.size > 100) throw new AdministrationError('reset-job-limit-exceeded')
        const jobs = rows.docs.map((doc) => ({
          ...parseValue(Job, doc.data(), () => new AdministrationError('invalid-reset-job')),
          ref: doc.ref,
        }))
        const scopeIds = [...new Set(jobs.map((job) => job.scopeId))]
        const scopeDocs = scopeIds.length
          ? await tx.getAll(...scopeIds.map((id) => this.db.doc(`scopes/${id}`)))
          : []
        for (const doc of scopeDocs) {
          if (!doc.exists) continue
          const previous = v.safeParse(TimestampSchema, doc.get('cooldownUntil'))
          if (previous.success && previous.output.toMillis() > until.toMillis())
            until = previous.output
        }
        const result = {
          action: 'acquisition-reset',
          applied: options.apply ?? false,
          queuedJobs: jobs.filter((job) => job.state === 'queued').length,
          runningJobs: jobs.filter((job) => job.state === 'running').length,
          retryNotBefore: until.toDate().toISOString(),
          cloudTasks: this.queue ? 'pause-and-purge' : 'local-emulator-skipped',
          queueName: this.queue?.name ?? null,
        }
        if (!options.apply) return result
        for (const job of jobs)
          tx.update(job.ref, {
            state: 'failed',
            errorCode: job.state === 'running' ? 'interrupted' : 'cancelled',
            dispatchState: 'recovery_required',
            capacityReserved: false,
            completedAt: Timestamp.fromDate(this.now()),
            cooldownUntil: until,
            leaseUntil: null,
          })
        for (const doc of scopeDocs) if (doc.exists) tx.update(doc.ref, { cooldownUntil: until })
        tx.set(this.db.doc('control/queueCapacity'), { schemaVersion: 1, pendingJobCount: 0 })
        tx.update(controlRef, {
          updatesEnabled: false,
          blockedReason: 'acquisition-reset',
          owner: null,
          leaseUntil: null,
          fence: control.fence + 1,
          recoveryGeneration: control.recoveryGeneration + 1,
          nextRequestNotBefore: until,
        })
        tx.set(sessionRef, {
          schemaVersion: 1,
          cookieJar: new CookieJar().serializeSync(),
          initialized: false,
          prepared: [],
          targets: [],
          sessionGeneration: metadata.success
            ? metadata.output.sessionGeneration + 1
            : control.recoveryGeneration + 1,
          revision: metadata.success ? metadata.output.revision + 1 : 0,
          initializationRetryAt: until,
          initializationError: null,
          lastUsedAt: null,
          inFlight: null,
          restorationState: 'usable',
        })
        return result
      },
      { maxAttempts: 3 },
    )
  }
}
