interface Bucket {
  start: number
  count: number
}

/**
 * RateLimiter is a fixed-window in-memory limiter. JS runs the allow() body
 * without preemption, so no lock is needed (unlike the Go mutex version).
 */
export class RateLimiter {
  private readonly items = new Map<string, Bucket>()
  constructor(private readonly max: number) {}

  allow(key: string, limit: number, windowMs: number, now: Date): boolean {
    const t = now.getTime()
    if (this.items.size >= this.max) {
      for (const [k, bucket] of this.items) {
        if (t - bucket.start >= windowMs) this.items.delete(k)
      }
      if (this.items.size >= this.max) return false
    }
    const bucket = this.items.get(key)
    if (bucket === undefined || t - bucket.start >= windowMs) {
      this.items.set(key, { start: t, count: 1 })
      return true
    }
    if (bucket.count >= limit) return false
    bucket.count++
    return true
  }
}
