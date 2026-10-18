import { randomUUID } from 'node:crypto'
import { Pool, PoolClient } from 'pg'
import { Result, Target } from '../availability/client'
import { offsetDate } from '../availability/parser'
import { transaction } from './database'

export type Job = {
  id: string
  scope_id: string
  state: string
  park_name?: string
  park_id: string
  surface: 'grass' | 'hard'
  week_start: string
  reused?: boolean
}
const leaseSeconds = 90
async function fence(client: PoolClient, owner: string): Promise<void> {
  const result = await client.query(
    'SELECT 1 FROM worker_lease WHERE id=1 AND owner=$1 AND expires_at>clock_timestamp() AND blocked_reason IS NULL FOR UPDATE',
    [owner],
  )
  if (!result.rowCount) throw new Error('lease-lost')
}
export class Store {
  constructor(readonly pool: Pool) {}
  async enqueue(targets: Target[], requireWorker = false): Promise<Job[]> {
    // Sort lock acquisition to avoid deadlocks across overlapping multi-scope requests.
    return transaction(this.pool, async (client) => {
      const lease = await client.query(
        'SELECT blocked_reason, owner IS NOT NULL AND expires_at>clock_timestamp() AS active FROM worker_lease WHERE id=1 FOR SHARE',
      )
      // Validate all requested pairs before reporting worker availability.
      for (const target of targets) {
        const enabled = await client.query(
          'SELECT 1 FROM park_surfaces WHERE park_id=$1 AND surface=$2 AND enabled',
          [target.parkId, target.surface],
        )
        if (!enabled.rowCount) throw new Error('unsupported-target')
      }
      if (requireWorker && !lease.rows[0]?.active) throw new Error('worker-unavailable')
      if (lease.rows[0]?.blocked_reason) throw new Error('worker-blocked')
      const jobs: Job[] = []
      for (const target of [...targets].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      )) {
        await client.query(
          'INSERT INTO acquisition_scopes(id,park_id,surface,week_start) VALUES($1,$2,$3,$4) ON CONFLICT(park_id,surface,week_start) DO NOTHING',
          [randomUUID(), target.parkId, target.surface, target.startDate],
        )
        const scope = (
          await client.query(
            'SELECT id FROM acquisition_scopes WHERE park_id=$1 AND surface=$2 AND week_start=$3 FOR UPDATE',
            [target.parkId, target.surface, target.startDate],
          )
        ).rows[0]
        const previous = await client.query(
          `SELECT id,state FROM acquisition_jobs WHERE scope_id=$1 AND (state IN ('queued','running') OR cooldown_until>clock_timestamp()) ORDER BY queued_at DESC LIMIT 1`,
          [scope.id],
        )
        const reused = !!previous.rowCount
        const job = previous.rows[0] || { id: randomUUID(), state: 'queued' }
        if (!reused) {
          await client.query('INSERT INTO acquisition_jobs(id,scope_id,state) VALUES($1,$2,$3)', [
            job.id,
            scope.id,
            'queued',
          ])
          await client.query('UPDATE acquisition_scopes SET latest_job_id=$2 WHERE id=$1', [
            scope.id,
            job.id,
          ])
        }
        jobs.push({
          ...job,
          scope_id: scope.id,
          park_id: target.parkId,
          surface: target.surface,
          week_start: target.startDate,
          reused,
        })
      }
      return jobs
    })
  }
  async takeLease(owner: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const lease = await client.query(
        `UPDATE worker_lease SET owner=$1,expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=1 AND blocked_reason IS NULL AND (expires_at IS NULL OR expires_at<=clock_timestamp()) RETURNING id`,
        [owner, leaseSeconds],
      )
      if (!lease.rowCount) return false
      await client.query(
        `UPDATE acquisition_jobs SET state='failed',error_code='interrupted',completed_at=clock_timestamp(),cooldown_until=clock_timestamp()+interval '15 minutes' WHERE state='running'`,
      )
      return true
    })
  }
  async heartbeat(owner: string): Promise<void> {
    const result = await this.pool.query(
      'UPDATE worker_lease SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=1 AND owner=$1 AND expires_at>clock_timestamp() AND blocked_reason IS NULL',
      [owner, leaseSeconds],
    )
    if (!result.rowCount) throw new Error('lease-lost')
  }
  async release(owner: string): Promise<void> {
    await this.pool.query(
      'UPDATE worker_lease SET owner=NULL,expires_at=NULL WHERE id=1 AND owner=$1',
      [owner],
    )
  }
  async claim(owner: string): Promise<Job | undefined> {
    return transaction(this.pool, async (client) => {
      await fence(client, owner)
      const result = await client.query(
        `SELECT j.id,j.scope_id,j.state,s.park_id,p.name AS park_name,s.surface,to_char(s.week_start,'YYYY-MM-DD') AS week_start FROM acquisition_jobs j JOIN acquisition_scopes s ON s.id=j.scope_id JOIN park_surfaces p ON p.park_id=s.park_id AND p.surface=s.surface WHERE j.state='queued' ORDER BY j.queued_at,j.id LIMIT 1 FOR UPDATE OF j`,
      )
      const job = result.rows[0]
      if (job)
        await client.query(
          `UPDATE acquisition_jobs SET state='running',owner=$2,started_at=clock_timestamp() WHERE id=$1`,
          [job.id, owner],
        )
      return job
    })
  }
  async beforeRequest(owner: string): Promise<number> {
    return transaction(this.pool, async (client) => {
      await fence(client, owner)
      const wait = (
        await client.query(
          `SELECT greatest(0,ceil(extract(epoch FROM (next_request_not_before-clock_timestamp()))*1000))::integer AS ms FROM worker_lease WHERE id=1`,
        )
      ).rows[0].ms
      if (wait === 0)
        await client.query(
          `UPDATE worker_lease SET next_request_not_before=clock_timestamp()+interval '2 seconds' WHERE id=1`,
        )
      return wait
    })
  }
  async progress(owner: string, job: Job, count: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      await fence(client, owner)
      await client.query(
        `UPDATE worker_lease SET next_request_not_before=greatest(next_request_not_before,clock_timestamp()+interval '2 seconds') WHERE id=1`,
      )
      await client.query(
        `UPDATE acquisition_jobs SET request_count=$3 WHERE id=$1 AND owner=$2 AND state='running'`,
        [job.id, owner, count],
      )
    })
  }
  async finish(owner: string, job: Job, result: Result): Promise<void> {
    await transaction(this.pool, async (client) => {
      await fence(client, owner)
      const active = await client.query(
        `SELECT 1 FROM acquisition_jobs WHERE id=$1 AND scope_id=$2 AND owner=$3 AND state='running' FOR UPDATE`,
        [job.id, job.scope_id, owner],
      )
      if (!active.rowCount) throw new Error('job-lost')
      if (
        result.target.parkId !== job.park_id ||
        result.target.surface !== job.surface ||
        result.target.startDate !== job.week_start
      )
        throw new Error('result-scope-mismatch')
      if (result.state === 'success') {
        const id = randomUUID()
        await client.query(
          'INSERT INTO snapshots(id,scope_id,started_at,completed_at,facility_count,checked_cells) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            job.scope_id,
            result.attemptedAt,
            result.completedAt,
            result.facilities.length,
            result.facilities.reduce((n, f) => n + f.week.checkedCells, 0),
          ],
        )
        const minute = (time: string): number => {
          const [h, m] = time.split(':').map(Number)
          return h * 60 + m
        }
        for (const facility of result.facilities) {
          if (
            facility.week.days.join(',') !==
            Array.from({ length: 7 }, (_, i) => offsetDate(job.week_start, i)).join(',')
          )
            throw new Error('incomplete-week')
          await client.query('INSERT INTO snapshot_facilities VALUES($1,$2,$3)', [
            id,
            facility.id,
            facility.name,
          ])
          for (const slot of facility.week.slots) {
            if (!facility.week.days.includes(slot.date)) throw new Error('slot-outside-week')
            await client.query('INSERT INTO slots VALUES($1,$2,$3,$4,$5,$6)', [
              id,
              facility.id,
              slot.date,
              minute(slot.start),
              minute(slot.end),
              slot.availableCourts,
            ])
          }
        }
        await client.query('UPDATE acquisition_scopes SET latest_snapshot_id=$2 WHERE id=$1', [
          job.scope_id,
          id,
        ])
      }
      await fence(client, owner)
      await client.query(
        `UPDATE acquisition_jobs SET state=$3,completed_at=$4,error_code=$5,request_count=$6,duration_ms=$7,cooldown_until=clock_timestamp()+interval '15 minutes' WHERE id=$1 AND owner=$2`,
        [
          job.id,
          owner,
          result.state === 'success' ? 'succeeded' : 'failed',
          result.completedAt,
          result.state === 'failed' ? result.error : null,
          result.requests.length,
          result.durationMs,
        ],
      )
    })
  }
  async resetBlock(): Promise<void> {
    const result = await this.pool.query(
      `UPDATE worker_lease SET blocked_reason=NULL WHERE id=1 AND (expires_at IS NULL OR expires_at<=clock_timestamp())`,
    )
    if (!result.rowCount) throw new Error('worker-still-running')
  }
}
