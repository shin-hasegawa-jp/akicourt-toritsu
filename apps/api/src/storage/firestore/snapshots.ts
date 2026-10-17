import * as v from 'valibot'
import { NonNegativeInteger, parseValue } from '../../validation'
import { ScopeSchema } from './schemas'
import { randomUUID } from 'node:crypto'
import { DocumentSnapshot, Firestore, Transaction } from '@google-cloud/firestore'
import { Result, Target } from '../../availability/client'
import {
  encodeSnapshot,
  limits,
  measureDocument,
  scopeId,
  validId,
  verifySnapshot,
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
    const snapshot = encodeSnapshot(result)
    const sizes = this.checkSize(ref.path, snapshot)
    await ref.create(snapshot)
    return { snapshotId, slotCount: snapshot.slotCount, ...sizes }
  }

  private checkSize(path: string, data: Record<string, unknown>) {
    const sizes = measureDocument(this.name(path), data)
    if (sizes.documentBytes > limits.documentBytes || sizes.wireBytes > limits.documentBytes)
      throw new Error('snapshot-capacity-exceeded')
    return sizes
  }

  async read(
    tx: Transaction,
    snapshotId: string,
    target: Target,
    observe?: (document: DocumentSnapshot) => void,
  ) {
    if (!validId(snapshotId)) throw new Error('invalid-snapshot-id')
    const ref = this.db.doc(`snapshots/${snapshotId}`)
    const document = await tx.get(ref)
    observe?.(document)
    const snapshot = verifySnapshot(document.data(), target)
    const sizes = this.checkSize(ref.path, snapshot)
    return { snapshot, slots: snapshot.payload, wireBytes: sizes.wireBytes }
  }

  // Low-level publication primitive. The acquisition worker must check owner/fence,
  // then call this inside the SAME transaction that finalizes its job and counters.
  // There is intentionally no route or management CLI exposing publication.
  async publish(tx: Transaction, snapshotId: string, target: Target, expectedGeneration: number) {
    if (!v.is(NonNegativeInteger, expectedGeneration)) throw new Error('invalid-generation')
    const id = scopeId(target)
    const ref = this.db.doc(`scopes/${id}`)
    const document = await tx.get(ref)
    const current = document.exists
      ? parseValue(ScopeSchema, document.data(), () => new Error('invalid-scope'))
      : undefined
    const { snapshot } = await this.read(tx, snapshotId, target)
    if (
      current &&
      (current.parkId !== target.parkId ||
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
        observedAt: snapshot.completedAt,
      },
      { merge: true },
    )
  }
}
