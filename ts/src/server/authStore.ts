import { Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

export class GrantNotFound extends Data.TaggedError("GrantNotFound")<{}> {}
export class GrantExpired extends Data.TaggedError("GrantExpired")<{}> {}
export class GrantPending extends Data.TaggedError("GrantPending")<{ readonly interval: number }> {}
export class GrantDenied extends Data.TaggedError("GrantDenied")<{}> {}
export class GrantConsumed extends Data.TaggedError("GrantConsumed")<{}> {}
export class SlowDown extends Data.TaggedError("SlowDown")<{ readonly interval: number }> {}
export class GrantLimitReached extends Data.TaggedError("GrantLimitReached")<{}> {}
export class SessionLimitReached extends Data.TaggedError("SessionLimitReached")<{}> {}
export class TokenNotFound extends Data.TaggedError("TokenNotFound")<{}> {}
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{}> {}

const MAX_ADMIN_SESSIONS = 256

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
  readonly createdAt: string
  readonly expiresAt: string
  readonly approvedAt: string | null
  readonly deniedAt: string | null
  readonly lastPollAt: string | null
  readonly pollIntervalSeconds: number
  readonly consumedAt: string | null
}

export interface NewDeviceAuthorization {
  readonly id: string
  readonly deviceCodeHash: string
  readonly deviceSecretHash: string
  readonly userCodeHash: string
  readonly deviceLabel: string
  readonly scopes: string
  readonly sourceKey: string
  readonly sourceHint: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly pollIntervalSeconds: number
}

export interface ApiToken {
  readonly id: string
  readonly tokenHash: string
  readonly displayPrefix: string
  readonly deviceLabel: string
  readonly scopes: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

export interface NewApiTokenRecord {
  readonly id: string
  readonly tokenHash: string
  readonly displayPrefix: string
  readonly deviceLabel: string
  readonly scopes: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface AdminSession {
  readonly id: string
  readonly sessionHash: string
  readonly authenticated: boolean
  readonly createdAt: string
  readonly expiresAt: string
}

interface GrantRow {
  readonly id: string
  readonly device_code_hash: string
  readonly device_secret_hash: string
  readonly user_code_hash: string
  readonly device_label: string
  readonly scopes: string
  readonly source_key: string
  readonly source_hint: string
  readonly status: string
  readonly created_at: string
  readonly expires_at: string
  readonly approved_at: string | null
  readonly denied_at: string | null
  readonly last_poll_at: string | null
  readonly poll_interval_seconds: number
  readonly consumed_at: string | null
}

interface TokenRow {
  readonly id: string
  readonly token_hash: string
  readonly display_prefix: string
  readonly device_label: string
  readonly scopes: string
  readonly created_at: string
  readonly expires_at: string
  readonly last_used_at: string | null
  readonly revoked_at: string | null
}

interface SessionRow {
  readonly id: string
  readonly session_hash: string
  readonly authenticated: number
  readonly created_at: string
  readonly expires_at: string
}

const rowToGrant = (row: GrantRow): DeviceAuthorization => ({
  id: row.id,
  deviceCodeHash: row.device_code_hash,
  deviceSecretHash: row.device_secret_hash,
  userCodeHash: row.user_code_hash,
  deviceLabel: row.device_label,
  scopes: row.scopes,
  sourceKey: row.source_key,
  sourceHint: row.source_hint,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  approvedAt: row.approved_at,
  deniedAt: row.denied_at,
  lastPollAt: row.last_poll_at,
  pollIntervalSeconds: row.poll_interval_seconds,
  consumedAt: row.consumed_at
})

const rowToToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  tokenHash: row.token_hash,
  displayPrefix: row.display_prefix,
  deviceLabel: row.device_label,
  scopes: row.scopes,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at
})

const rowToSession = (row: SessionRow): AdminSession => ({
  id: row.id,
  sessionHash: row.session_hash,
  authenticated: row.authenticated !== 0,
  createdAt: row.created_at,
  expiresAt: row.expires_at
})

const GRANT_COLUMNS = `id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes,
  source_key, source_hint, status, created_at, expires_at, approved_at, denied_at, last_poll_at,
  poll_interval_seconds, consumed_at`

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const grantByDeviceCode = (codeHash: string, secretHash: string, now: string) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<GrantRow>(
        `SELECT ${GRANT_COLUMNS} FROM device_authorizations
         WHERE device_code_hash = ? AND device_secret_hash = ?`,
        [codeHash, secretHash]
      )
      const row = rows[0]
      if (row === undefined) return yield* new GrantNotFound()
      if (row.expires_at <= now) return yield* new GrantExpired()
      return rowToGrant(row)
    })

  return {
    createDeviceAuthorization: (
      grant: NewDeviceAuthorization,
      perSource: number,
      perInstance: number
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const source = yield* sql<{ n: number }>`SELECT count(*) AS n FROM device_authorizations
            WHERE source_key = ${grant.sourceKey} AND status = 'pending' AND expires_at > ${grant.createdAt}`
          const total = yield* sql<{ n: number }>`SELECT count(*) AS n FROM device_authorizations
            WHERE status = 'pending' AND expires_at > ${grant.createdAt}`
          if ((source[0]?.n ?? 0) >= perSource || (total[0]?.n ?? 0) >= perInstance) {
            return yield* new GrantLimitReached()
          }
          yield* sql`INSERT INTO device_authorizations
            (id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes,
             source_key, source_hint, status, created_at, expires_at, poll_interval_seconds)
            VALUES (${grant.id}, ${grant.deviceCodeHash}, ${grant.deviceSecretHash}, ${grant.userCodeHash},
                    ${grant.deviceLabel}, ${grant.scopes}, ${grant.sourceKey}, ${grant.sourceHint},
                    'pending', ${grant.createdAt}, ${grant.expiresAt}, ${grant.pollIntervalSeconds})`
        })
      ),

    deviceAuthorizationByUserCode: (userCodeHash: string, now: string) =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM device_authorizations WHERE user_code_hash = ?`,
          [userCodeHash]
        )
        const row = rows[0]
        if (row === undefined) return yield* new GrantNotFound()
        if (row.expires_at <= now) return yield* new GrantExpired()
        return rowToGrant(row)
      }),

    deviceAuthorizationByDeviceCode: grantByDeviceCode,

    decideDeviceAuthorization: (userCodeHash: string, decision: "approved" | "denied", now: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`SELECT id FROM device_authorizations
            WHERE user_code_hash = ${userCodeHash} AND status = 'pending' AND expires_at > ${now}`
          const row = rows[0]
          if (row === undefined) return yield* new GrantNotFound()
          if (decision === "approved") {
            yield* sql`UPDATE device_authorizations SET status = 'approved', approved_at = ${now} WHERE id = ${row.id}`
          } else {
            yield* sql`UPDATE device_authorizations SET status = 'denied', denied_at = ${now} WHERE id = ${row.id}`
          }
        })
      ),

    // pollDeviceAuthorization advances the persisted polling state. When the
    // grant is approved it mints the token and consumes the grant in the same
    // transaction, so replays can never mint a second token. Pending/slow-down
    // outcomes are returned as values from the transaction (and only raised as
    // failures afterwards) because their poll-state writes must still commit.
    pollDeviceAuthorization: (
      codeHash: string,
      secretHash: string,
      now: string,
      token: NewApiTokenRecord
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const grant = yield* grantByDeviceCode(codeHash, secretHash, now)
            if (grant.status === "denied") return yield* new GrantDenied()
            if (grant.status === "consumed") return yield* new GrantConsumed()
            if (grant.status === "approved") {
              yield* sql`INSERT INTO api_tokens
                (id, token_hash, display_prefix, device_label, scopes, created_at, expires_at)
                VALUES (${token.id}, ${token.tokenHash}, ${token.displayPrefix}, ${token.deviceLabel},
                        ${token.scopes}, ${token.createdAt}, ${token.expiresAt})`
              yield* sql`UPDATE device_authorizations SET status = 'consumed', consumed_at = ${now}
                         WHERE id = ${grant.id} AND status = 'approved'`
              return null
            }
            if (
              grant.lastPollAt !== null &&
              now <
                new Date(
                  Date.parse(grant.lastPollAt) + grant.pollIntervalSeconds * 1000
                ).toISOString()
            ) {
              const interval = Math.min(grant.pollIntervalSeconds + 5, 30)
              yield* sql`UPDATE device_authorizations SET last_poll_at = ${now}, poll_interval_seconds = ${interval}
                         WHERE id = ${grant.id}`
              return new SlowDown({ interval })
            }
            if (grant.status === "pending") {
              yield* sql`UPDATE device_authorizations SET last_poll_at = ${now} WHERE id = ${grant.id}`
              return new GrantPending({ interval: grant.pollIntervalSeconds })
            }
            return yield* new GrantNotFound()
          })
        )
        .pipe(
          Effect.flatMap((outcome) => (outcome === null ? Effect.void : Effect.fail(outcome)))
        ),

    apiTokenByHash: (tokenHash: string, now: string) =>
      Effect.flatMap(
        sql<TokenRow>`SELECT id, token_hash, display_prefix, device_label, scopes, created_at,
                             expires_at, last_used_at, revoked_at
                      FROM api_tokens
                      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > ${now}`,
        (rows) =>
          rows[0] === undefined
            ? Effect.fail(new TokenNotFound())
            : Effect.succeed(rowToToken(rows[0]))
      ),

    touchApiToken: (id: string, now: string) =>
      sql`UPDATE api_tokens SET last_used_at = ${now}
          WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at <= ${new Date(
            Date.parse(now) - 5 * 60 * 1000
          ).toISOString()})`.pipe(Effect.asVoid),

    revokeApiToken: (id: string, now: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`SELECT id FROM api_tokens
            WHERE id = ${id} AND revoked_at IS NULL`
          if (rows[0] === undefined) return yield* new TokenNotFound()
          yield* sql`UPDATE api_tokens SET revoked_at = ${now} WHERE id = ${id}`
        })
      ),

    listApiTokens: Effect.map(
      sql<TokenRow>`SELECT id, token_hash, display_prefix, device_label, scopes, created_at,
                           expires_at, last_used_at, revoked_at
                    FROM api_tokens ORDER BY created_at DESC`,
      (rows) => rows.map(rowToToken)
    ),

    createAdminSession: (session: AdminSession) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM admin_sessions WHERE expires_at <= ${session.createdAt}`
          const active = yield* sql<{ n: number }>`SELECT count(*) AS n FROM admin_sessions`
          if ((active[0]?.n ?? 0) >= MAX_ADMIN_SESSIONS) {
            return yield* new SessionLimitReached()
          }
          yield* sql`INSERT INTO admin_sessions (id, session_hash, authenticated, created_at, expires_at)
            VALUES (${session.id}, ${session.sessionHash}, ${session.authenticated ? 1 : 0},
                    ${session.createdAt}, ${session.expiresAt})`
        })
      ),

    adminSessionByHash: (sessionHash: string, now: string) =>
      Effect.flatMap(
        sql<SessionRow>`SELECT id, session_hash, authenticated, created_at, expires_at
                        FROM admin_sessions WHERE session_hash = ${sessionHash} AND expires_at > ${now}`,
        (rows) =>
          rows[0] === undefined
            ? Effect.fail(new SessionNotFound())
            : Effect.succeed(rowToSession(rows[0]))
      ),

    authenticateAdminSession: (id: string, expiresAt: string) =>
      sql`UPDATE admin_sessions SET authenticated = 1, expires_at = ${expiresAt} WHERE id = ${id}`.pipe(
        Effect.asVoid
      ),

    deleteAdminSession: (id: string) =>
      sql`DELETE FROM admin_sessions WHERE id = ${id}`.pipe(Effect.asVoid),

    deleteExpiredAuth: (now: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          let total = 0
          for (const table of ["device_authorizations", "api_tokens", "admin_sessions"]) {
            const counted = yield* sql.unsafe<{ n: number }>(
              `SELECT count(*) AS n FROM ${table} WHERE expires_at <= ?`,
              [now]
            )
            yield* sql.unsafe(`DELETE FROM ${table} WHERE expires_at <= ?`, [now])
            total += counted[0]?.n ?? 0
          }
          return total
        })
      )
  } as const
})

export class AuthStore extends Context.Service<AuthStore>()("AuthStore", { make }) {}

export const AuthStoreLive = Layer.effect(AuthStore)(AuthStore.make)
