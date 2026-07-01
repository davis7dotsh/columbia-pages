import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { schema } from "./schema.ts"
import {
  type AdminSession,
  type APIToken,
  type DeviceAuthorization,
  GrantConsumed,
  GrantDenied,
  GrantExpired,
  GrantNotFound,
  GrantPending,
  LimitReached,
  type Meta,
  NotFound,
  type Page,
  SessionLimit,
  SlowDown,
} from "./models.ts"

const iso = (d: Date): string => d.toISOString()
const parseNull = (s: string | null | undefined): Date | null => (s == null ? null : new Date(s))
const boolToInt = (b: boolean): number => (b ? 1 : 0)

interface PageRow {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly html: string
  readonly raw: number
  readonly created_at: string
  readonly updated_at: string
  readonly expires_at: string | null
}
interface MetaRow extends Omit<PageRow, "html"> {
  readonly size: number
}
interface CountRow {
  readonly n: number
}
interface DeviceRow {
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

const toPage = (r: PageRow): Page => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  html: r.html,
  raw: r.raw !== 0,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
  expiresAt: parseNull(r.expires_at),
})

const toMeta = (r: MetaRow): Meta => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  raw: r.raw !== 0,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
  expiresAt: parseNull(r.expires_at),
  size: r.size,
})

const toDevice = (r: DeviceRow): DeviceAuthorization => ({
  id: r.id,
  deviceCodeHash: r.device_code_hash,
  deviceSecretHash: r.device_secret_hash,
  userCodeHash: r.user_code_hash,
  deviceLabel: r.device_label,
  scopes: r.scopes,
  sourceKey: r.source_key,
  sourceHint: r.source_hint,
  status: r.status,
  createdAt: new Date(r.created_at),
  expiresAt: new Date(r.expires_at),
  approvedAt: parseNull(r.approved_at),
  deniedAt: parseNull(r.denied_at),
  lastPollAt: parseNull(r.last_poll_at),
  pollIntervalSeconds: r.poll_interval_seconds,
  consumedAt: parseNull(r.consumed_at),
})

const toToken = (r: TokenRow): APIToken => ({
  id: r.id,
  tokenHash: r.token_hash,
  displayPrefix: r.display_prefix,
  deviceLabel: r.device_label,
  scopes: r.scopes,
  createdAt: new Date(r.created_at),
  expiresAt: new Date(r.expires_at),
  lastUsedAt: parseNull(r.last_used_at),
  revokedAt: parseNull(r.revoked_at),
})

const toSession = (r: SessionRow): AdminSession => ({
  id: r.id,
  sessionHash: r.session_hash,
  authenticated: r.authenticated !== 0,
  createdAt: new Date(r.created_at),
  expiresAt: new Date(r.expires_at),
})

const maxAdminSessions = 256

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // WAL + a generous busy timeout keep the single-user workload contention-free.
  yield* sql.unsafe("PRAGMA journal_mode = WAL")
  yield* sql.unsafe("PRAGMA busy_timeout = 5000")
  yield* sql.unsafe("PRAGMA foreign_keys = ON")

  // Run migrations. Split on ';' since no statement embeds one.
  for (const stmt of schema.split(";")) {
    const trimmed = stmt.trim()
    if (trimmed !== "") yield* sql.unsafe(trimmed)
  }

  const changes = Effect.map(sql<CountRow>`SELECT changes() AS n`, (rows) => rows[0]?.n ?? 0)

  // --- pages ---------------------------------------------------------------

  const create = (p: Page): Effect.Effect<void, SqlError> =>
    sql`INSERT INTO pages (id, title, slug, html, raw, created_at, updated_at, expires_at)
        VALUES (${p.id}, ${p.title}, ${p.slug}, ${p.html}, ${boolToInt(p.raw)}, ${iso(p.createdAt)}, ${iso(p.updatedAt)}, ${p.expiresAt ? iso(p.expiresAt) : null})`.pipe(
      Effect.asVoid,
    )

  const get = (id: string): Effect.Effect<Page, SqlError | NotFound> =>
    Effect.flatMap(
      sql<PageRow>`SELECT id, title, slug, html, raw, created_at, updated_at, expires_at FROM pages WHERE id = ${id}`,
      (rows) => (rows[0] === undefined ? Effect.fail(new NotFound()) : Effect.succeed(toPage(rows[0]))),
    )

  const save = (p: Page): Effect.Effect<void, SqlError | NotFound> =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE pages SET title = ${p.title}, slug = ${p.slug}, html = ${p.html}, raw = ${boolToInt(p.raw)},
            updated_at = ${iso(p.updatedAt)}, expires_at = ${p.expiresAt ? iso(p.expiresAt) : null} WHERE id = ${p.id}`
        if ((yield* changes) === 0) return yield* Effect.fail(new NotFound())
      }),
    )

  const del = (id: string): Effect.Effect<void, SqlError | NotFound> =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM pages WHERE id = ${id}`
        if ((yield* changes) === 0) return yield* Effect.fail(new NotFound())
      }),
    )

  const list = (limit: number): Effect.Effect<ReadonlyArray<Meta>, SqlError> =>
    Effect.map(
      limit > 0
        ? sql<MetaRow>`SELECT id, title, slug, raw, created_at, updated_at, expires_at, length(html) AS size
             FROM pages ORDER BY created_at DESC LIMIT ${limit}`
        : sql<MetaRow>`SELECT id, title, slug, raw, created_at, updated_at, expires_at, length(html) AS size
             FROM pages ORDER BY created_at DESC`,
      (rows) => rows.map(toMeta),
    )

  const deleteExpired = (now: Date): Effect.Effect<number, SqlError> =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM pages WHERE expires_at IS NOT NULL AND expires_at <= ${iso(now)}`
        return yield* changes
      }),
    )

  const deleteExpiredAuth = (now: Date): Effect.Effect<number, SqlError> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const cutoff = iso(now)
        let total = 0
        yield* sql`DELETE FROM device_authorizations WHERE expires_at <= ${cutoff}`
        total += yield* changes
        yield* sql`DELETE FROM api_tokens WHERE expires_at <= ${cutoff}`
        total += yield* changes
        yield* sql`DELETE FROM admin_sessions WHERE expires_at <= ${cutoff}`
        total += yield* changes
        return total
      }),
    )

  // --- device authorizations ----------------------------------------------

  const createDeviceAuthorization = (
    g: DeviceAuthorization,
    perSource: number,
    perInstance: number,
  ): Effect.Effect<void, SqlError | LimitReached> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const created = iso(g.createdAt)
        const sourceCount = (yield* sql<CountRow>`SELECT count(*) AS n FROM device_authorizations
            WHERE source_key = ${g.sourceKey} AND status = 'pending' AND expires_at > ${created}`)[0]!.n
        const totalCount = (yield* sql<CountRow>`SELECT count(*) AS n FROM device_authorizations
            WHERE status = 'pending' AND expires_at > ${created}`)[0]!.n
        if (sourceCount >= perSource || totalCount >= perInstance) {
          return yield* Effect.fail(new LimitReached())
        }
        yield* sql`INSERT INTO device_authorizations
            (id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint, status, created_at, expires_at, poll_interval_seconds)
            VALUES (${g.id}, ${g.deviceCodeHash}, ${g.deviceSecretHash}, ${g.userCodeHash}, ${g.deviceLabel}, ${g.scopes}, ${g.sourceKey}, ${g.sourceHint}, 'pending', ${created}, ${iso(g.expiresAt)}, ${g.pollIntervalSeconds})`
      }),
    )

  const deviceSelect = `SELECT id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint,
        status, created_at, expires_at, approved_at, denied_at, last_poll_at, poll_interval_seconds, consumed_at FROM device_authorizations`

  const deviceAuthorizationByUserCode = (
    hash: string,
    now: Date,
  ): Effect.Effect<DeviceAuthorization, SqlError | GrantNotFound | GrantExpired> =>
    Effect.flatMap(
      sql<DeviceRow>`${sql.unsafe(deviceSelect)} WHERE user_code_hash = ${hash}`,
      (rows): Effect.Effect<DeviceAuthorization, GrantNotFound | GrantExpired> => {
        if (rows[0] === undefined) return Effect.fail(new GrantNotFound())
        const g = toDevice(rows[0])
        return g.expiresAt.getTime() > now.getTime() ? Effect.succeed(g) : Effect.fail(new GrantExpired())
      },
    )

  const deviceAuthorizationByDeviceCode = (
    codeHash: string,
    secretHash: string,
    now: Date,
  ): Effect.Effect<DeviceAuthorization, SqlError | GrantNotFound | GrantExpired> =>
    Effect.flatMap(
      sql<DeviceRow>`${sql.unsafe(deviceSelect)} WHERE device_code_hash = ${codeHash} AND device_secret_hash = ${secretHash}`,
      (rows): Effect.Effect<DeviceAuthorization, GrantNotFound | GrantExpired> => {
        if (rows[0] === undefined) return Effect.fail(new GrantNotFound())
        const g = toDevice(rows[0])
        return g.expiresAt.getTime() > now.getTime() ? Effect.succeed(g) : Effect.fail(new GrantExpired())
      },
    )

  const decideDeviceAuthorization = (
    hash: string,
    decision: "approved" | "denied",
    now: Date,
  ): Effect.Effect<void, SqlError | GrantNotFound> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const column = decision === "denied" ? sql.literal("denied_at") : sql.literal("approved_at")
        yield* sql`UPDATE device_authorizations SET status = ${decision}, ${column} = ${iso(now)}
            WHERE user_code_hash = ${hash} AND status = 'pending' AND expires_at > ${iso(now)}`
        if ((yield* changes) === 0) return yield* Effect.fail(new GrantNotFound())
      }),
    )

  /**
   * pollDeviceAuthorization advances the persisted polling state. When the grant
   * is approved it creates the token and consumes the grant in one transaction.
   * Success yields void; all other outcomes are tagged errors.
   */
  const pollDeviceAuthorization = (
    codeHash: string,
    secretHash: string,
    now: Date,
    token: APIToken,
  ): Effect.Effect<
    void,
    SqlError | GrantNotFound | GrantExpired | GrantDenied | GrantConsumed | GrantPending | SlowDown
  > =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql<DeviceRow>`${sql.unsafe(deviceSelect)} WHERE device_code_hash = ${codeHash} AND device_secret_hash = ${secretHash}`
        if (rows[0] === undefined) return yield* Effect.fail(new GrantNotFound())
        const g = toDevice(rows[0])
        if (g.expiresAt.getTime() <= now.getTime()) return yield* Effect.fail(new GrantExpired())
        if (g.status === "denied") return yield* Effect.fail(new GrantDenied())
        if (g.status === "consumed") return yield* Effect.fail(new GrantConsumed())
        if (g.status === "approved") {
          yield* sql`INSERT INTO api_tokens (id, token_hash, display_prefix, device_label, scopes, created_at, expires_at)
              VALUES (${token.id}, ${token.tokenHash}, ${token.displayPrefix}, ${token.deviceLabel}, ${token.scopes}, ${iso(token.createdAt)}, ${iso(token.expiresAt)})`
          yield* sql`UPDATE device_authorizations SET status = 'consumed', consumed_at = ${iso(now)} WHERE id = ${g.id} AND status = 'approved'`
          if ((yield* changes) !== 1) return yield* Effect.fail(new GrantConsumed())
          return
        }
        if (g.lastPollAt !== null && now.getTime() < g.lastPollAt.getTime() + g.pollIntervalSeconds * 1000) {
          const interval = Math.min(g.pollIntervalSeconds + 5, 30)
          yield* sql`UPDATE device_authorizations SET last_poll_at = ${iso(now)}, poll_interval_seconds = ${interval} WHERE id = ${g.id}`
          return yield* Effect.fail(new SlowDown({ interval }))
        }
        if (g.status === "pending") {
          yield* sql`UPDATE device_authorizations SET last_poll_at = ${iso(now)} WHERE id = ${g.id}`
          return yield* Effect.fail(new GrantPending({ interval: g.pollIntervalSeconds }))
        }
        return yield* Effect.fail(new GrantNotFound())
      }),
    )

  // --- api tokens ----------------------------------------------------------

  const tokenSelect = `SELECT id, token_hash, display_prefix, device_label, scopes, created_at, expires_at, last_used_at, revoked_at FROM api_tokens`

  const apiTokenByHash = (hash: string, now: Date): Effect.Effect<APIToken, SqlError | NotFound> =>
    Effect.flatMap(
      sql<TokenRow>`${sql.unsafe(tokenSelect)} WHERE token_hash = ${hash} AND revoked_at IS NULL AND expires_at > ${iso(now)}`,
      (rows) => (rows[0] === undefined ? Effect.fail(new NotFound()) : Effect.succeed(toToken(rows[0]))),
    )

  const touchAPIToken = (id: string, now: Date): Effect.Effect<void, SqlError> =>
    sql`UPDATE api_tokens SET last_used_at = ${iso(now)} WHERE id = ${id}
        AND (last_used_at IS NULL OR last_used_at <= ${iso(new Date(now.getTime() - 5 * 60 * 1000))})`.pipe(Effect.asVoid)

  const revokeAPIToken = (id: string, now: Date): Effect.Effect<void, SqlError | NotFound> =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE api_tokens SET revoked_at = ${iso(now)} WHERE id = ${id} AND revoked_at IS NULL`
        if ((yield* changes) === 0) return yield* Effect.fail(new NotFound())
      }),
    )

  const listAPITokens = (): Effect.Effect<ReadonlyArray<APIToken>, SqlError> =>
    Effect.map(sql<TokenRow>`${sql.unsafe(tokenSelect)} ORDER BY created_at DESC`, (rows) => rows.map(toToken))

  // --- admin sessions ------------------------------------------------------

  const createAdminSession = (session: AdminSession): Effect.Effect<void, SqlError | SessionLimit> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = iso(session.createdAt)
        yield* sql`DELETE FROM admin_sessions WHERE expires_at <= ${now}`
        const active = (yield* sql<CountRow>`SELECT count(*) AS n FROM admin_sessions`)[0]!.n
        if (active >= maxAdminSessions) return yield* Effect.fail(new SessionLimit())
        yield* sql`INSERT INTO admin_sessions (id, session_hash, authenticated, created_at, expires_at)
            VALUES (${session.id}, ${session.sessionHash}, ${boolToInt(session.authenticated)}, ${now}, ${iso(session.expiresAt)})`
      }),
    )

  const adminSessionByHash = (hash: string, now: Date): Effect.Effect<AdminSession, SqlError | NotFound> =>
    Effect.flatMap(
      sql<SessionRow>`SELECT id, session_hash, authenticated, created_at, expires_at FROM admin_sessions
          WHERE session_hash = ${hash} AND expires_at > ${iso(now)}`,
      (rows) => (rows[0] === undefined ? Effect.fail(new NotFound()) : Effect.succeed(toSession(rows[0]))),
    )

  const authenticateAdminSession = (id: string, expiresAt: Date): Effect.Effect<void, SqlError> =>
    sql`UPDATE admin_sessions SET authenticated = 1, expires_at = ${iso(expiresAt)} WHERE id = ${id}`.pipe(Effect.asVoid)

  const deleteAdminSession = (id: string): Effect.Effect<void, SqlError> =>
    sql`DELETE FROM admin_sessions WHERE id = ${id}`.pipe(Effect.asVoid)

  return {
    create,
    get,
    save,
    del,
    list,
    deleteExpired,
    deleteExpiredAuth,
    createDeviceAuthorization,
    deviceAuthorizationByUserCode,
    deviceAuthorizationByDeviceCode,
    decideDeviceAuthorization,
    pollDeviceAuthorization,
    apiTokenByHash,
    touchAPIToken,
    revokeAPIToken,
    listAPITokens,
    createAdminSession,
    adminSessionByHash,
    authenticateAdminSession,
    deleteAdminSession,
  } as const
})

export class Store extends Context.Service<Store, Effect.Success<typeof make>>()("Store") {
  static readonly layer = Layer.effect(Store, make)
}
