import { createHash } from 'node:crypto'
import { Timestamp } from '@google-cloud/firestore'
// The pinned SDK exposes the protobuf encoder at runtime but not in its TS declarations.
// Keep this small boundary covered by byte-size tests when upgrading the SDK.
const sdk = require('@google-cloud/firestore') as {
  protos: {
    google: {
      firestore: {
        v1: {
          Document: {
            encode(document: { name: string; fields: Record<string, unknown> }): {
              finish(): Uint8Array
            }
          }
        }
      }
    }
  }
}
import { Result, Target } from '../../availability/client'
import { offsetDate, validateDate } from '../../availability/parser'

export const limits = {
  chunkBytes: 256 * 1024,
  documentBytes: 512 * 1024,
  chunks: 64,
  searchBytes: 32 * 1024 * 1024,
}
export type StoredSlot = {
  facilityId: string
  date: string
  start: string
  end: string
  availableCourts: number
}
export type Chunk = {
  schemaVersion: number
  ordinal: number
  payload: StoredSlot[]
  checksum: string
}
export type Manifest = {
  schemaVersion: number
  scopeId: string
  target: Target
  attemptedAt: Timestamp
  completedAt: Timestamp
  facilities: { id: string; name: string; checkedCells: number }[]
  chunkIds: string[]
  chunkChecksums: string[]
  slotCount: number
  complete: boolean
  checksum: string
}
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort((left, right) => {
                  if (left === right) return 0
                  return left < right ? -1 : 1
                })
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex')
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const fail = (): never => {
  throw new Error('invalid-snapshot')
}
export function scopeId(target: Target) {
  if (
    !/^\d{4}$/.test(target.parkId) ||
    !['grass', 'hard'].includes(target.surface) ||
    new Date(`${validateDate(target.startDate)}T00:00:00Z`).getUTCDay() !== 1
  )
    return fail()
  return `${target.parkId}_${target.surface}_${target.startDate}`
}
export function validSlot(slot: StoredSlot, target: Target) {
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  return (
    validId(slot.facilityId) &&
    validateDate(slot.date) >= target.startDate &&
    slot.date <= offsetDate(target.startDate, 6) &&
    clock.test(slot.start) &&
    clock.test(slot.end) &&
    slot.start < slot.end &&
    Number.isSafeInteger(slot.availableCourts) &&
    slot.availableCourts > 0
  )
}
// Official storage-size formula, distinct from UTF-8 JSON and protobuf wire size.
const textBytes = (s: string) => Buffer.byteLength(s) + 1
function fieldBytes(value: unknown): number {
  if (value === null || typeof value === 'boolean') return 1
  if (typeof value === 'number' || value instanceof Timestamp) return 8
  if (typeof value === 'string') return textBytes(value)
  if (Array.isArray(value)) return value.reduce((n, v) => n + fieldBytes(v), 0)
  if (value && typeof value === 'object') return mapBytes(value as Record<string, unknown>)
  return fail()
}
function mapBytes(value: Record<string, unknown>): number {
  return 32 + Object.entries(value).reduce((n, [k, v]) => n + textBytes(k) + fieldBytes(v), 0)
}
function wireValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: 0 }
  if (value instanceof Timestamp)
    return { timestampValue: { seconds: value.seconds, nanos: value.nanoseconds } }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number')
    return Number.isSafeInteger(value) ? { integerValue: value } : { doubleValue: value }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wireValue) } }
  if (value && typeof value === 'object')
    return { mapValue: { fields: wireFields(value as Record<string, unknown>) } }
  return fail()
}
function wireFields(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wireValue(v)]))
}
export function measureDocument(name: string, data: Record<string, unknown>) {
  const path = name.split('/documents/')[1]
  if (!path) return fail()
  return {
    documentBytes: path.split('/').reduce((n, s) => n + textBytes(s), 16) + mapBytes(data),
    wireBytes: sdk.protos.google.firestore.v1.Document.encode({
      name,
      fields: wireFields(data),
    }).finish().length,
  }
}
export function manifestChecksum(manifest: Omit<Manifest, 'checksum'> | Manifest) {
  return digest({
    scopeId: manifest.scopeId,
    target: manifest.target,
    attemptedAt: manifest.attemptedAt.toMillis(),
    completedAt: manifest.completedAt.toMillis(),
    facilities: manifest.facilities,
    chunkIds: manifest.chunkIds,
    chunkChecksums: manifest.chunkChecksums,
    slotCount: manifest.slotCount,
  })
}
export function encodeSnapshot(result: Extract<Result, { state: 'success' }>) {
  const id = scopeId(result.target)
  if (
    !result.facilities.length ||
    new Set(result.facilities.map((f) => f.id)).size !== result.facilities.length
  )
    return fail()
  const expectedDays = Array.from({ length: 7 }, (_, i) => offsetDate(result.target.startDate, i))
  const rows: StoredSlot[] = []
  const unique = new Set<string>()
  for (const facility of result.facilities) {
    if (
      !validId(facility.id) ||
      !facility.name.trim() ||
      !Number.isSafeInteger(facility.week.checkedCells) ||
      facility.week.checkedCells < 1 ||
      facility.week.days.join(',') !== expectedDays.join(',')
    )
      return fail()
    for (const s of facility.week.slots) {
      const row = {
        facilityId: facility.id,
        date: s.date,
        start: s.start,
        end: s.end,
        availableCourts: s.availableCourts,
      }
      const key = `${row.facilityId}/${row.date}/${row.start}/${row.end}`
      if (!validSlot(row, result.target) || unique.has(key)) return fail()
      unique.add(key)
      rows.push(row)
    }
  }
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start) ||
      a.facilityId.localeCompare(b.facilityId),
  )
  const chunks: Chunk[] = []
  let payload: StoredSlot[] = []
  let bytes = 2
  const flush = () => {
    if (payload.length)
      chunks.push({ schemaVersion: 1, ordinal: chunks.length, payload, checksum: digest(payload) })
    payload = []
    bytes = 2
    if (chunks.length > limits.chunks) throw new Error('snapshot-capacity-exceeded')
  }
  for (const row of rows) {
    const size = jsonBytes(row)
    if (size + 2 > limits.chunkBytes) throw new Error('snapshot-capacity-exceeded')
    if (bytes + size + (payload.length ? 1 : 0) > limits.chunkBytes) flush()
    bytes += size + (payload.length ? 1 : 0)
    payload.push(row)
  }
  flush()
  const manifest: Manifest = {
    schemaVersion: 1,
    scopeId: id,
    target: {
      parkId: result.target.parkId,
      surface: result.target.surface,
      startDate: result.target.startDate,
    },
    attemptedAt: Timestamp.fromDate(new Date(result.attemptedAt)),
    completedAt: Timestamp.fromDate(new Date(result.completedAt)),
    facilities: result.facilities.map((f) => ({
      id: f.id,
      name: f.name,
      checkedCells: f.week.checkedCells,
    })),
    chunkIds: chunks.map((c) => String(c.ordinal).padStart(4, '0')),
    chunkChecksums: chunks.map((c) => c.checksum),
    slotCount: rows.length,
    complete: false,
    checksum: '',
  }
  if (manifest.attemptedAt.toMillis() > manifest.completedAt.toMillis()) return fail()
  manifest.checksum = manifestChecksum(manifest)
  return { manifest, chunks }
}
export function verifyManifest(value: unknown, target: Target): Manifest {
  const m = value as Manifest
  if (
    !m ||
    m.schemaVersion !== 1 ||
    m.scopeId !== scopeId(target) ||
    scopeId(m.target) !== m.scopeId ||
    !(m.attemptedAt instanceof Timestamp) ||
    !(m.completedAt instanceof Timestamp) ||
    m.attemptedAt.toMillis() > m.completedAt.toMillis() ||
    !Array.isArray(m.facilities) ||
    !m.facilities.length ||
    m.facilities.some(
      (f) =>
        !validId(f.id) ||
        typeof f.name !== 'string' ||
        !f.name.trim() ||
        !Number.isSafeInteger(f.checkedCells) ||
        f.checkedCells < 1,
    ) ||
    new Set(m.facilities.map((f) => f.id)).size !== m.facilities.length ||
    !Array.isArray(m.chunkIds) ||
    m.chunkIds.length > limits.chunks ||
    m.chunkIds.some((s, i) => s !== String(i).padStart(4, '0')) ||
    !Array.isArray(m.chunkChecksums) ||
    m.chunkChecksums.length !== m.chunkIds.length ||
    m.chunkChecksums.some((s) => typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s)) ||
    !Number.isSafeInteger(m.slotCount) ||
    m.slotCount < 0 ||
    typeof m.complete !== 'boolean' ||
    manifestChecksum(m) !== m.checksum
  )
    return fail()
  return m
}
export function verifyChunks(manifest: Manifest, values: unknown[]): StoredSlot[] {
  if (values.length !== manifest.chunkIds.length) return fail()
  const result: StoredSlot[] = []
  const unique = new Set<string>()
  const facilityIds = new Set(manifest.facilities.map((f) => f.id))
  values.forEach((value, i) => {
    const chunk = value as Chunk
    if (
      !chunk ||
      chunk.schemaVersion !== 1 ||
      chunk.ordinal !== i ||
      !Array.isArray(chunk.payload) ||
      !chunk.payload.length ||
      jsonBytes(chunk.payload) > limits.chunkBytes ||
      digest(chunk.payload) !== chunk.checksum ||
      chunk.checksum !== manifest.chunkChecksums[i]
    )
      return fail()
    for (const row of chunk.payload) {
      const key = `${row.facilityId}/${row.date}/${row.start}/${row.end}`
      if (!validSlot(row, manifest.target) || !facilityIds.has(row.facilityId) || unique.has(key))
        return fail()
      unique.add(key)
      result.push(row)
    }
  })
  if (result.length !== manifest.slotCount) return fail()
  return result
}
