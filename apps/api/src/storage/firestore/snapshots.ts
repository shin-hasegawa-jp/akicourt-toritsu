import { randomUUID } from 'node:crypto'
import { DocumentSnapshot, Firestore, Transaction } from '@google-cloud/firestore'
import { Result, Target } from '../../availability/client'
import {
  encodeSnapshot,
  limits,
  measureDocument,
  scopeId,
  validId,
  verifyChunks,
  verifyManifest,
} from './snapshot-codec'

export class SnapshotRepository {
  constructor(
    private readonly db: Firestore,
    private readonly projectId: string,
  ) {}
  private name(path: string) {
    return `projects/${this.projectId}/databases/${this.db.databaseId}/documents/${path}`
  }
  async stage(result: Extract<Result, { state: 'success' }>) {
    const snapshotId = randomUUID()
    const ref = this.db.doc(`snapshots/${snapshotId}`)
    const { manifest, chunks } = encodeSnapshot(result)
    const documents = [
      { path: ref.path, data: manifest },
      ...chunks.map((data, i) => ({ path: `${ref.path}/chunks/${manifest.chunkIds[i]}`, data })),
    ]
    const sizes = documents.map(({ path, data }) => measureDocument(this.name(path), data))
    if (
      sizes.some(
        (s) => s.documentBytes > limits.documentBytes || s.wireBytes > limits.documentBytes,
      )
    )
      throw new Error('snapshot-capacity-exceeded')
    await ref.create(manifest)
    // Keep each Commit comfortably below the 10MiB API request limit.
    for (let start = 0; start < chunks.length; start += 16) {
      const batch = this.db.batch()
      chunks
        .slice(start, start + 16)
        .forEach((chunk, i) =>
          batch.create(ref.collection('chunks').doc(manifest.chunkIds[start + i]), chunk),
        )
      await batch.commit()
    }
    await this.db.runTransaction(
      async (tx) => {
        await this.read(tx, snapshotId, result.target, false)
        tx.update(ref, { complete: true })
      },
      { maxAttempts: 3 },
    )
    return {
      snapshotId,
      chunkCount: chunks.length,
      slotCount: manifest.slotCount,
      maxDocumentBytes: Math.max(...sizes.map((s) => s.documentBytes)),
      wireBytes: sizes.reduce((n, s) => n + s.wireBytes, 0),
    }
  }

  async read(
    tx: Transaction,
    snapshotId: string,
    target: Target,
    requireComplete = true,
    observe?: (document: DocumentSnapshot) => void,
  ) {
    if (!validId(snapshotId)) throw new Error('invalid-snapshot-id')
    const ref = this.db.doc(`snapshots/${snapshotId}`)
    const document = await tx.get(ref)
    observe?.(document)
    const manifest = verifyManifest(document.data(), target)
    if (requireComplete && !manifest.complete) throw new Error('incomplete-snapshot')
    const chunkDocuments = manifest.chunkIds.length
      ? await tx.getAll(...manifest.chunkIds.map((id) => ref.collection('chunks').doc(id)))
      : []
    for (const document of chunkDocuments) observe?.(document)
    const slots = verifyChunks(
      manifest,
      chunkDocuments.map((d) => d.data()),
    )
    const documents = [
      { path: ref.path, data: manifest },
      ...chunkDocuments.map((d) => ({ path: d.ref.path, data: d.data()! })),
    ]
    const sizes = documents.map(({ path, data }) => measureDocument(this.name(path), data))
    if (
      sizes.some(
        (s) => s.documentBytes > limits.documentBytes || s.wireBytes > limits.documentBytes,
      )
    )
      throw new Error('snapshot-capacity-exceeded')
    return { manifest, slots, wireBytes: sizes.reduce((n, s) => n + s.wireBytes, 0) }
  }

  // Low-level publication primitive. The acquisition worker must check owner/fence,
  // then call this inside the SAME transaction that finalizes its job and counters.
  // There is intentionally no route or management CLI exposing publication.
  async publish(tx: Transaction, snapshotId: string, target: Target, expectedGeneration: number) {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
      throw new Error('invalid-generation')
    const id = scopeId(target)
    const ref = this.db.doc(`scopes/${id}`)
    const current = (await tx.get(ref)).data()
    const { manifest } = await this.read(tx, snapshotId, target)
    if (
      current &&
      (current.schemaVersion !== 1 ||
        !Number.isSafeInteger(current.publicationGeneration) ||
        current.publicationGeneration < 0 ||
        (current.latestSnapshotId !== null && !validId(current.latestSnapshotId)) ||
        current.parkId !== target.parkId ||
        current.surface !== target.surface ||
        current.weekStart !== target.startDate)
    )
      throw new Error('invalid-scope')
    if ((current?.publicationGeneration ?? 0) !== expectedGeneration)
      throw new Error('publication-conflict')
    if (current?.latestSnapshotId === snapshotId) throw new Error('snapshot-already-published')
    tx.set(
      ref,
      {
        schemaVersion: 1,
        parkId: target.parkId,
        surface: target.surface,
        weekStart: target.startDate,
        latestSnapshotId: snapshotId,
        previousSnapshotId: current?.latestSnapshotId ?? null,
        publicationGeneration: expectedGeneration + 1,
        observedAt: manifest.completedAt,
      },
      { merge: true },
    )
  }
}
