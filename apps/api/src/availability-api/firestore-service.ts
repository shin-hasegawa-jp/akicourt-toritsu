import * as v from 'valibot'
import { Firestore } from '@google-cloud/firestore'
import { Id, NonNegativeInteger, TargetSchema, parseValue } from '../validation'
import { ApiError, Input, resolveInput } from './input'
import { JobRepository } from '../storage/firestore/jobs'
import { ReferenceRepository } from '../storage/firestore/reference-data'
import { FirestoreSearch } from '../storage/firestore/search'
import { AttemptSchema, TimestampSchema } from '../storage/firestore/schemas'
import { scopeId } from '../storage/firestore/snapshot-codec'
import { Dispatcher, dispatchPending } from '../storage/firestore/task-dispatcher'

const Job = v.intersect([
  AttemptSchema,
  v.object({
    target: TargetSchema,
    startedAt: v.nullable(TimestampSchema),
    completedAt: v.nullable(TimestampSchema),
    cooldownUntil: TimestampSchema,
    requestCount: NonNegativeInteger,
  }),
])
const unavailable = () => new ApiError(503, 'storage_unavailable', '保存先を利用できません。')

export class FirestoreAvailabilityService {
  private readonly jobs: JobRepository
  constructor(
    private readonly db: Firestore,
    private readonly projectId: string,
    private readonly dispatcher?: Dispatcher,
    private readonly now = () => new Date(),
  ) {
    this.jobs = new JobRepository(db, now)
  }

  async parks() {
    const { parks } = await new ReferenceRepository(this.db).read()
    const first = parks[0]
    if (!first) throw unavailable()
    return {
      defaultTarget: parks.some((p) => p.parkId === '1280' && p.surface === 'grass')
        ? '1280:grass'
        : `${first.parkId}:${first.surface}`,
      groups: (['hard', 'grass'] as const).map((surface) => ({
        surface,
        label: surface === 'hard' ? 'ハード' : '人工芝',
        parks: parks
          .filter((p) => p.surface === surface)
          .map((p) => ({ parkId: p.parkId, parkName: p.name })),
      })),
    }
  }

  async search(input: Input, query = resolveInput(input)) {
    const result = await new FirestoreSearch(this.db, this.projectId).search(
      input,
      this.now(),
      query,
    )
    return {
      ...result,
      scopes: result.scopes.map((scope) => ({
        ...scope,
        latestAttempt: scope.latestAttempt
          ? {
              jobId: scope.latestAttempt.jobId,
              state: scope.latestAttempt.state,
              errorCode: scope.latestAttempt.errorCode,
            }
          : null,
      })),
    }
  }

  async updates(input: Input, query = resolveInput(input, true)) {
    if (!this.dispatcher)
      throw new ApiError(503, 'worker_unavailable', '更新受付は停止しています。')
    const accepted = await this.jobs.enqueue(query.targets)
    // Resubmission retries pending registration using the same job and task name.
    // A failed dispatch keeps the durable job; no background retry is scheduled.
    await dispatchPending(
      this.jobs,
      this.dispatcher,
      accepted.map(({ jobId, generation }) => ({ jobId, generation })),
    )
    const jobs = await Promise.all(
      accepted.map(async (job) => ({ ...(await this.job(job.jobId)), reused: job.reused })),
    )
    return {
      status: jobs.some((j) => j.state === 'queued' || j.state === 'running') ? 202 : 200,
      body: { dateFrom: query.dateFrom, dateTo: query.dateTo, jobs, pollAfterSeconds: 3 },
    }
  }

  async job(id: string) {
    if (!v.is(Id, id)) throw new ApiError(400, 'invalid_request', '入力内容を確認してください。')
    const doc = await this.db.doc(`jobs/${id}`).get()
    if (!doc.exists) throw new ApiError(404, 'job_not_found', '更新ジョブが見つかりません。')
    const job = parseValue(Job, doc.data(), unavailable)
    if (job.scopeId !== scopeId(job.target)) throw unavailable()
    return {
      jobId: id,
      parkId: job.target.parkId,
      surface: job.target.surface,
      weekStart: job.target.startDate,
      state: job.state,
      queuedAt: job.queuedAt.toDate().toISOString(),
      startedAt: job.startedAt?.toDate().toISOString() ?? null,
      completedAt: job.completedAt?.toDate().toISOString() ?? null,
      errorCode: job.errorCode,
      requestCount: job.requestCount,
      retryAfter: Math.max(
        0,
        Math.ceil((job.cooldownUntil.toMillis() - this.now().getTime()) / 1000),
      ),
    }
  }
}
