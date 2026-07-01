import { Data } from "effect"

// --- domain models ---------------------------------------------------------

export interface Page {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly html: string
  readonly raw: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date | null // null = never expires
}

export interface Meta {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly raw: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date | null
  readonly size: number // bytes of HTML
}

export interface DeviceAuthorization {
  readonly id: string
  readonly deviceCodeHash: string
  readonly deviceSecretHash: string
  readonly userCodeHash: string
  readonly deviceLabel: string
  readonly scopes: string
  readonly sourceKey: string
  readonly sourceHint: string
  readonly status: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly approvedAt: Date | null
  readonly deniedAt: Date | null
  readonly lastPollAt: Date | null
  readonly pollIntervalSeconds: number
  readonly consumedAt: Date | null
}

export interface APIToken {
  readonly id: string
  readonly tokenHash: string
  readonly displayPrefix: string
  readonly deviceLabel: string
  readonly scopes: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly lastUsedAt: Date | null
  readonly revokedAt: Date | null
}

export interface AdminSession {
  readonly id: string
  readonly sessionHash: string
  readonly authenticated: boolean
  readonly createdAt: Date
  readonly expiresAt: Date
}

// --- tagged errors ---------------------------------------------------------

export class NotFound extends Data.TaggedError("NotFound")<{}> {}
export class GrantNotFound extends Data.TaggedError("GrantNotFound")<{}> {}
export class GrantExpired extends Data.TaggedError("GrantExpired")<{}> {}
export class GrantPending extends Data.TaggedError("GrantPending")<{ readonly interval: number }> {}
export class GrantDenied extends Data.TaggedError("GrantDenied")<{}> {}
export class GrantConsumed extends Data.TaggedError("GrantConsumed")<{}> {}
export class SlowDown extends Data.TaggedError("SlowDown")<{ readonly interval: number }> {}
export class LimitReached extends Data.TaggedError("LimitReached")<{}> {}
export class SessionLimit extends Data.TaggedError("SessionLimit")<{}> {}
