import * as v from 'valibot'
import { parseValue } from '../validation'
import { firestoreSettings } from '../storage/firestore/database'

export function localSettings(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV === 'production') throw new Error('local-runtime-forbidden')
  firestoreSettings(
    {
      projectId: environment.GOOGLE_CLOUD_PROJECT ?? '',
      databaseId: environment.FIRESTORE_DATABASE_ID ?? '',
    },
    environment,
  )
  return parseValue(
    v.object({
      mode: v.picklist(['fixture', 'live']),
      workerUrl: v.pipe(
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
    }),
    {
      mode: environment.LOCAL_ACQUISITION,
      workerUrl: environment.LOCAL_WORKER_URL ?? 'http://worker:3000',
    },
    () => new Error('invalid-local-settings'),
  )
}
