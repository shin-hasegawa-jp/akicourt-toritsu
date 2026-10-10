import { Pool, PoolClient } from 'pg'
import { transaction } from '../storage/database'
import { Store } from '../storage/store'
import { ApiError, Input, resolveInput } from './input'

async function enabled(client: PoolClient, input: Input): Promise<void> {
  for (const target of input.targets) {
    const result = await client.query(
      'SELECT 1 FROM park_surfaces WHERE park_id=$1 AND surface=$2 AND enabled',
      [target.parkId, target.surface],
    )
    if (!result.rowCount) throw new ApiError(400, 'invalid_request', '未対応の公園・種目です。')
  }
}
const time = (minute: number) =>
  `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`
export class AvailabilityService {
  constructor(readonly pool: Pool) {}
  async search(input: Input, query = resolveInput(input)) {
    return transaction(this.pool, async (client) => {
      // All scope pointers, jobs, holidays and slots are read from one MVCC snapshot.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await enabled(client, input)
      const generatedAt = (await client.query('SELECT transaction_timestamp() AS now')).rows[0]
        .now as Date
      const holidayNeeded = query.includeHolidays && query.weekdays.length < 7
      if (holidayNeeded) {
        const years = [
          ...new Set([Number(query.dateFrom.slice(0, 4)), Number(query.dateTo.slice(0, 4))]),
        ]
        const coverage = await client.query(
          'SELECT year FROM holiday_calendar_years WHERE year=ANY($1::integer[])',
          [years],
        )
        if (coverage.rowCount !== years.length)
          throw new ApiError(503, 'holiday_calendar_unavailable', '対象年の祝日情報が未登録です。')
      }
      const output = []
      const slots = []
      for (const target of query.targets) {
        const found = await client.query(
          `SELECT s.latest_snapshot_id,n.completed_at,j.id AS job_id,j.state,j.error_code,p.name FROM park_surfaces p LEFT JOIN acquisition_scopes s ON s.park_id=p.park_id AND s.surface=p.surface AND s.week_start=$3 LEFT JOIN snapshots n ON n.id=s.latest_snapshot_id LEFT JOIN acquisition_jobs j ON j.id=s.latest_job_id WHERE p.park_id=$1 AND p.surface=$2`,
          [target.parkId, target.surface, target.startDate],
        )
        const row = found.rows[0]
        output.push({
          parkId: target.parkId,
          surface: target.surface,
          weekStart: target.startDate,
          dataState: !row.latest_snapshot_id
            ? 'unavailable'
            : generatedAt.getTime() - row.completed_at.getTime() <= 900000
              ? 'fresh'
              : 'stale',
          snapshotId: row.latest_snapshot_id ?? null,
          lastSuccessAt: row.completed_at?.toISOString() ?? null,
          latestAttempt: row.job_id
            ? { jobId: row.job_id, state: row.state, errorCode: row.error_code }
            : null,
        })
        if (!row.latest_snapshot_id) continue
        const foundSlots = await client.query(
          `SELECT f.facility_id,f.name,to_char(s.use_date,'YYYY-MM-DD') AS use_date,s.start_minute,s.end_minute,s.available_courts FROM slots s JOIN snapshot_facilities f ON f.snapshot_id=s.snapshot_id AND f.facility_id=s.facility_id WHERE s.snapshot_id=$1 AND s.use_date BETWEEN $2::date AND $3::date AND (extract(dow FROM s.use_date)::integer=ANY($4::integer[]) OR ($5::boolean AND EXISTS(SELECT 1 FROM holidays h WHERE h.use_date=s.use_date))) AND s.start_minute >= $6 AND s.end_minute <= $7 AND s.end_minute-s.start_minute >= $8 ORDER BY s.use_date,s.start_minute,f.facility_id LIMIT 10001`,
          [
            row.latest_snapshot_id,
            query.dateFrom,
            query.dateTo,
            query.weekdays,
            holidayNeeded,
            query.timeFrom,
            query.timeTo,
            query.minDurationMinutes,
          ],
        )
        for (const slot of foundSlots.rows)
          slots.push({
            parkId: target.parkId,
            parkName: row.name,
            surface: target.surface,
            facilityId: slot.facility_id,
            facilityName: slot.name,
            date: slot.use_date,
            start: time(slot.start_minute),
            end: time(slot.end_minute),
            availableCourts: slot.available_courts,
            snapshotId: row.latest_snapshot_id,
            observedAt: row.completed_at.toISOString(),
          })
        if (slots.length > 10000)
          throw new ApiError(503, 'response_too_large', '検索結果が上限を超えています。')
      }
      slots.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.start.localeCompare(b.start) ||
          a.parkId.localeCompare(b.parkId) ||
          a.facilityId.localeCompare(b.facilityId),
      )
      const count = output.filter((s) => s.snapshotId).length
      return {
        generatedAt: generatedAt.toISOString(),
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        coverage: count === output.length ? 'complete' : count ? 'partial' : 'none',
        scopes: output,
        slots,
        officialUrl: 'https://kouen.sports.metro.tokyo.lg.jp/web/',
      }
    })
  }
  async updates(input: Input, query = resolveInput(input, true)) {
    // Enqueue checks the live worker while holding a shared lease row lock.
    const jobs = await new Store(this.pool).enqueue(query.targets, true)
    const details = await Promise.all(
      jobs.map(async (job) => ({ ...(await this.job(job.id)), reused: !!job.reused })),
    )
    return {
      status: details.some((j) => j.state === 'queued' || j.state === 'running') ? 202 : 200,
      body: { dateFrom: query.dateFrom, dateTo: query.dateTo, jobs: details, pollAfterSeconds: 3 },
    }
  }
  async job(id: string) {
    const result = await this.pool.query(
      `SELECT j.*,s.park_id,s.surface,to_char(s.week_start,'YYYY-MM-DD') AS week_start,greatest(0,ceil(extract(epoch FROM (j.cooldown_until-clock_timestamp()))))::integer AS retry_after FROM acquisition_jobs j JOIN acquisition_scopes s ON s.id=j.scope_id WHERE j.id=$1`,
      [id],
    )
    const row = result.rows[0]
    if (!row) throw new ApiError(404, 'job_not_found', '更新ジョブが見つかりません。')
    return {
      jobId: row.id,
      parkId: row.park_id,
      surface: row.surface,
      weekStart: row.week_start,
      state: row.state,
      queuedAt: row.queued_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      errorCode: row.error_code,
      requestCount: row.request_count,
      retryAfter: row.retry_after ?? 0,
    }
  }
}
