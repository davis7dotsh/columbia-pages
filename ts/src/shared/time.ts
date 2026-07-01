import { Clock, Effect } from "effect"

// All timestamps are stored and compared as fixed-width UTC ISO strings
// (`Date.toISOString()`), which order lexicographically. Reading the clock via
// the Clock service keeps every time-dependent code path testable.
export const nowIso: Effect.Effect<string> = Effect.map(
  Clock.currentTimeMillis,
  (millis) => new Date(millis).toISOString()
)

export const addSecondsIso = (iso: string, seconds: number): string =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString()

export const addDaysIso = (iso: string, days: number): string =>
  addSecondsIso(iso, days * 24 * 60 * 60)

// ttlToExpiry converts a TTL in days to an absolute expiry, or null if days <= 0.
export const ttlToExpiry = (nowIsoValue: string, days: number): string | null =>
  days <= 0 ? null : addDaysIso(nowIsoValue, days)

export const isExpired = (expiresAtIso: string, nowIsoValue: string): boolean =>
  expiresAtIso <= nowIsoValue
