import { Clock, Context, Effect, Layer } from "effect"

interface Bucket {
  readonly start: number
  readonly count: number
}

const MAX_BUCKETS = 4096

// Fixed-window in-memory limiter, same shape as the Go implementation. When
// the bucket map is full, expired buckets are evicted; if it is still full the
// request is rejected rather than growing without bound.
const make = Effect.sync(() => {
  const items = new Map<string, Bucket>()

  const allow = (key: string, limit: number, windowMillis: number) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (items.size >= MAX_BUCKETS) {
        for (const [k, bucket] of items) {
          if (now - bucket.start >= windowMillis) items.delete(k)
        }
        if (items.size >= MAX_BUCKETS) return false
      }
      const bucket = items.get(key)
      if (bucket === undefined || now - bucket.start >= windowMillis) {
        items.set(key, { start: now, count: 1 })
        return true
      }
      if (bucket.count >= limit) return false
      items.set(key, { start: bucket.start, count: bucket.count + 1 })
      return true
    })

  return { allow } as const
})

export class RateLimiter extends Context.Service<RateLimiter>()("RateLimiter", { make }) {}

export const RateLimiterLive = Layer.effect(RateLimiter)(RateLimiter.make)
