import { ApiError } from './input'

export const requestTimeoutMs = 30000
export const storageTimeoutMs = 10000
const perMinute = { search: 60, job: 300, updates: 12, parks: 60 }
export type RequestKind = keyof typeof perMinute

// Four fixed counters per API instance; no IP storage or distributed limiter.
export class RequestLimits {
  private started: number
  private counts = { search: 0, job: 0, updates: 0, parks: 0 }
  constructor(private readonly now = () => performance.now()) {
    this.started = now()
  }
  retryAfter(kind: RequestKind) {
    const now = this.now()
    if (now - this.started >= 60000) {
      this.started = now
      this.counts = { search: 0, job: 0, updates: 0, parks: 0 }
    }
    if (this.counts[kind] >= perMinute[kind])
      return Math.ceil((60000 - (now - this.started)) / 1000)
    this.counts[kind]++
    return 0
  }
}

// Bounds waiting only. Already issued SDK operations may still commit; a later
// manual update reuses their durable job rather than creating a duplicate.
export async function withTimeout<T>(
  operation: () => Promise<T>,
  ms = storageTimeoutMs,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ApiError(
                503,
                'request_timeout',
                '処理に時間がかかっています。再試行してください。',
              ),
            ),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
