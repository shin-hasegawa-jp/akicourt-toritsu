import * as v from 'valibot'
import { CookieJar } from 'tough-cookie'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { NonNegativeInteger, parseValue } from '../../validation'
import { restoreSession } from '../../availability/session-state'
import {
  ControlSchema,
  QueueSchema,
  SessionDocumentSchema,
  TimestampSchema,
  Versioned,
} from './schemas'

export const adminCommands = [
  'pause',
  'resume',
  'clear-block',
  'session-disable',
  'session-discard',
  'session-recover',
] as const
export type AdminCommand = (typeof adminCommands)[number]
const Metadata = v.looseObject({
  ...Versioned.entries,
  sessionGeneration: NonNegativeInteger,
  revision: NonNegativeInteger,
  initializationRetryAt: TimestampSchema,
  initializationError: v.nullable(v.string()),
})
export class AdministrationError extends Error {}
const invalid = () => new AdministrationError('invalid-admin-state')
const resetSession = (command: AdminCommand) =>
  command === 'session-discard' || command === 'session-recover'
function usable(session: v.InferOutput<typeof SessionDocumentSchema>, now: Date) {
  if (session.restorationState !== 'usable' || session.inFlight !== null)
    throw new AdministrationError('session-recovery-required')
  try {
    restoreSession(
      {
        ...session,
        initializationRetryAt: session.initializationRetryAt.toMillis(),
        initializationError: session.initializationError ?? 'invalid-home',
      },
      now,
    )
  } catch {
    throw new AdministrationError('session-recovery-required')
  }
}

// Operator-only transactions. No official HTTP and no Cookie values in results.
export class Administration {
  constructor(
    private readonly db: Firestore,
    private readonly now = () => new Date(),
  ) {}

  async execute(
    command: AdminCommand,
    options: { apply?: boolean; confirmWorkerStopped?: boolean } = {},
  ) {
    const apply = options.apply ?? false
    return this.db.runTransaction(
      async (tx) => {
        const controlRef = this.db.doc('control/acquisition')
        const control = parseValue(ControlSchema, (await tx.get(controlRef)).data(), invalid)
        if (command === 'pause') {
          const changed = control.updatesEnabled
          if (apply && changed) tx.update(controlRef, { updatesEnabled: false })
          return { action: command, changed, applied: apply && changed }
        }
        const now = this.now()
        // Expiry alone does not prove that an old worker's official HTTP has stopped.
        // An interrupted job must be finalized separately before session operations.
        if (control.owner !== null || control.leaseUntil !== null)
          throw new AdministrationError('worker-not-released')
        if (command !== 'resume' && control.updatesEnabled)
          throw new AdministrationError('pause-required')
        const ref = this.db.doc('officialSessions/current')
        const doc = await tx.get(ref)
        const session =
          command === 'resume' || command === 'clear-block'
            ? parseValue(SessionDocumentSchema, doc.data(), invalid)
            : null
        const metadata = session ?? parseValue(Metadata, doc.data(), invalid)
        if (session) {
          usable(session, now)
          if (command === 'resume') {
            parseValue(
              QueueSchema,
              (await tx.get(this.db.doc('control/queueCapacity'))).data(),
              invalid,
            )
            if (control.blockedReason !== null)
              throw new AdministrationError('clear-block-required')
            if (
              Math.max(
                control.nextRequestNotBefore.toMillis(),
                metadata.initializationRetryAt.toMillis(),
              ) > now.getTime()
            )
              throw new AdministrationError('cooldown-active')
          }
          const changed =
            command === 'resume' ? !control.updatesEnabled : control.blockedReason !== null
          if (apply && changed)
            tx.update(
              controlRef,
              command === 'resume' ? { updatesEnabled: true } : { blockedReason: null },
            )
          return { action: command, changed, applied: apply && changed }
        }
        const resetting = resetSession(command)
        if (apply && resetting && !options.confirmWorkerStopped)
          throw new AdministrationError('worker-stopped-confirmation-required')
        const until = Timestamp.fromMillis(
          Math.max(
            metadata.initializationRetryAt.toMillis(),
            control.nextRequestNotBefore.toMillis(),
            now.getTime() + 900000,
          ),
        )
        if (apply) {
          tx.update(ref, {
            restorationState: command === 'session-recover' ? 'usable' : 'disabled',
            revision: metadata.revision + 1,
            ...(resetting
              ? {
                  cookieJar: new CookieJar().serializeSync(),
                  initialized: false,
                  prepared: [],
                  targets: [],
                  inFlight: null,
                  sessionGeneration: metadata.sessionGeneration + 1,
                  initializationRetryAt: until,
                }
              : {}),
          })
          tx.update(controlRef, {
            fence: control.fence + 1,
            // Session operations never remove an official access block.
            blockedReason: control.blockedReason ?? 'session-recovery-required',
            ...(resetting ? { nextRequestNotBefore: until } : {}),
          })
        }
        return {
          action: command,
          changed: true,
          applied: apply,
          requiresWorkerStoppedConfirmation: resetting,
          ...(resetting ? { retryNotBefore: until.toDate().toISOString() } : {}),
        }
      },
      { maxAttempts: 3 },
    )
  }

  async status() {
    return this.db.runTransaction(
      async (tx) => {
        const [controlDoc, queueDoc, sessionDoc] = await tx.getAll(
          this.db.doc('control/acquisition'),
          this.db.doc('control/queueCapacity'),
          this.db.doc('officialSessions/current'),
        )
        if (![controlDoc, queueDoc, sessionDoc].some((doc) => doc.exists))
          return { initialized: false }
        const control = parseValue(ControlSchema, controlDoc.data(), invalid)
        const queue = parseValue(QueueSchema, queueDoc.data(), invalid)
        const session = v.safeParse(SessionDocumentSchema, sessionDoc.data())
        const partial = session.success ? null : v.safeParse(Metadata, sessionDoc.data())
        const metadata = session.success ? session.output : partial?.success ? partial.output : null
        let sessionUsable = false
        if (session.success) {
          try {
            usable(session.output, this.now())
            sessionUsable = true
          } catch {
            /* State only; never print validation inputs or Cookie errors. */
          }
        }
        return {
          initialized: true,
          updatesEnabled: control.updatesEnabled,
          blockedReason: control.blockedReason,
          pendingJobCount: queue.pendingJobCount,
          sessionGeneration: metadata?.sessionGeneration ?? null,
          sessionRevision: metadata?.revision ?? null,
          restorationState: session.success ? session.output.restorationState : 'invalid',
          sessionUsable,
          lastUsedAt: session.success
            ? (session.output.lastUsedAt?.toDate().toISOString() ?? null)
            : null,
          initializationRetryAt: metadata?.initializationRetryAt.toDate().toISOString() ?? null,
          nextRequestNotBefore: control.nextRequestNotBefore.toDate().toISOString(),
          leaseUntil: control.leaseUntil?.toDate().toISOString() ?? null,
          inFlight: session.success ? session.output.inFlight !== null : null,
        }
      },
      { readOnly: true },
    )
  }
}
