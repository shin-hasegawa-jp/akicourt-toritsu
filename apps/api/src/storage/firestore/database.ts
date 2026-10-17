import { Firestore, Settings } from '@google-cloud/firestore'

export type Connection = { projectId: string; databaseId: string }

// Local commands must not fall through to ADC and connect to a live project.
export function firestoreSettings(
  connection: Connection,
  environment: NodeJS.ProcessEnv = process.env,
): Settings {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(connection.projectId))
    throw new Error('invalid-project')
  if (connection.databaseId !== '(default)') throw new Error('unsupported-database')
  const host = environment.FIRESTORE_EMULATOR_HOST
  if (environment.NODE_ENV === 'production') {
    if (host !== undefined || connection.projectId.startsWith('demo-'))
      throw new Error('invalid-production-firestore')
  } else {
    const match = /^(?:firestore|localhost|127\.0\.0\.1):(\d+)$/.exec(host || '')
    if (
      connection.projectId !== 'demo-akicourt-local' ||
      !match ||
      Number(match[1]) < 1 ||
      Number(match[1]) > 65535
    )
      throw new Error('local-emulator-required')
  }
  // Explicit host avoids relying on a second environment lookup by the SDK.
  return {
    ...connection,
    ...(host ? { host, ssl: false, universeDomain: 'googleapis.com' } : {}),
  }
}

export function connectFirestore(connection: Connection): Firestore {
  return new Firestore(firestoreSettings(connection))
}
