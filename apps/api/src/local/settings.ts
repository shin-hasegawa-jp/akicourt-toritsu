import * as v from 'valibot'
import { parseValue } from '../validation'
import { firestoreSettings } from '../storage/firestore/database'

export function localDeliverySettings(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV === 'production') throw new Error('local-runtime-forbidden')
  firestoreSettings(
    {
      projectId: environment.GOOGLE_CLOUD_PROJECT ?? '',
      databaseId: environment.FIRESTORE_DATABASE_ID ?? '',
    },
    environment,
  )
  return parseValue(
    v.pipe(
      v.string(),
      v.url(),
      v.check((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'http:' &&
          ['worker', 'localhost', '127.0.0.1'].includes(url.hostname) &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        )
      }),
      v.transform((value) => new URL(value).origin),
    ),
    environment.LOCAL_WORKER_URL,
    () => new Error('invalid-local-worker-url'),
  )
}
