import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AuthStore, type NewDeviceAuthorization } from "../src/server/authStore.ts"
import { runWithStores } from "./stores.ts"

const T0 = "2026-07-01T00:00:00.000Z"
const T0_PLUS_10S = "2026-07-01T00:00:10.000Z"
const T0_PLUS_1M = "2026-07-01T00:01:00.000Z"
const GRANT_EXPIRES = "2026-07-01T00:10:00.000Z"

const grant = (overrides: Partial<NewDeviceAuthorization> = {}): NewDeviceAuthorization => ({
  id: "grant-1",
  deviceCodeHash: "code-hash",
  deviceSecretHash: "secret-hash",
  userCodeHash: "user-code-hash",
  deviceLabel: "cpages on test",
  scopes: "pages:read pages:write",
  sourceKey: "source-1",
  sourceHint: "127.0.0.1",
  createdAt: T0,
  expiresAt: GRANT_EXPIRES,
  pollIntervalSeconds: 5,
  ...overrides
})

const token = {
  id: "token-1",
  tokenHash: "token-hash",
  displayPrefix: "cpages_token1",
  deviceLabel: "cpages on test",
  scopes: "pages:read pages:write",
  createdAt: T0_PLUS_1M,
  expiresAt: "2026-09-29T00:00:00.000Z"
}

describe("AuthStore device authorization flow", () => {
  test("pending poll, approval, token mint, and consumed replay", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createDeviceAuthorization(grant(), 5, 50)

        // First poll is pending and records the poll time.
        const pending = yield* auth
          .pollDeviceAuthorization("code-hash", "secret-hash", T0, token)
          .pipe(Effect.flip)
        // An immediate second poll is throttled.
        const throttled = yield* auth
          .pollDeviceAuthorization("code-hash", "secret-hash", T0, token)
          .pipe(Effect.flip)

        yield* auth.decideDeviceAuthorization("user-code-hash", "approved", T0_PLUS_10S)
        // Approval wins even inside the throttle window.
        yield* auth.pollDeviceAuthorization("code-hash", "secret-hash", T0_PLUS_10S, token)
        const minted = yield* auth.apiTokenByHash("token-hash", T0_PLUS_1M)

        // A consumed grant is terminal: replay must never mint again.
        const replay = yield* auth
          .pollDeviceAuthorization("code-hash", "secret-hash", T0_PLUS_1M, token)
          .pipe(Effect.flip)
        return { pending, throttled, minted, replay }
      })
    )
    expect(result.pending._tag).toBe("GrantPending")
    expect(result.throttled._tag).toBe("SlowDown")
    expect(result.minted.deviceLabel).toBe("cpages on test")
    expect(result.replay._tag).toBe("GrantConsumed")
  })

  test("denied grant reports access denied", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createDeviceAuthorization(grant(), 5, 50)
        yield* auth.decideDeviceAuthorization("user-code-hash", "denied", T0)
        return yield* auth
          .pollDeviceAuthorization("code-hash", "secret-hash", T0_PLUS_10S, token)
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("GrantDenied")
  })

  test("expired grant is rejected", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createDeviceAuthorization(grant(), 5, 50)
        return yield* auth
          .pollDeviceAuthorization("code-hash", "secret-hash", "2026-07-01T00:10:00.000Z", token)
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("GrantExpired")
  })

  test("per-source pending limit is enforced", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createDeviceAuthorization(grant(), 1, 50)
        return yield* auth
          .createDeviceAuthorization(
            grant({ id: "grant-2", deviceCodeHash: "c2", userCodeHash: "u2" }),
            1,
            50
          )
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("GrantLimitReached")
  })

  test("revoked tokens stop authenticating", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createDeviceAuthorization(grant(), 5, 50)
        yield* auth.decideDeviceAuthorization("user-code-hash", "approved", T0)
        yield* auth.pollDeviceAuthorization("code-hash", "secret-hash", T0_PLUS_10S, token)
        yield* auth.revokeApiToken("token-1", T0_PLUS_1M)
        return yield* auth.apiTokenByHash("token-hash", T0_PLUS_1M).pipe(Effect.flip)
      })
    )
    expect(result._tag).toBe("TokenNotFound")
  })

  test("admin sessions authenticate and delete", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.createAdminSession({
          id: "session-1",
          sessionHash: "session-hash",
          authenticated: false,
          createdAt: T0,
          expiresAt: GRANT_EXPIRES
        })
        const preAuth = yield* auth.adminSessionByHash("session-hash", T0)
        yield* auth.authenticateAdminSession("session-1", "2026-07-31T00:00:00.000Z")
        const authed = yield* auth.adminSessionByHash("session-hash", T0)
        yield* auth.deleteAdminSession("session-1")
        const gone = yield* auth.adminSessionByHash("session-hash", T0).pipe(Effect.flip)
        return { preAuth, authed, gone }
      })
    )
    expect(result.preAuth.authenticated).toBe(false)
    expect(result.authed.authenticated).toBe(true)
    expect(result.gone._tag).toBe("SessionNotFound")
  })
})
