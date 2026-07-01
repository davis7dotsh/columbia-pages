import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { SCOPE_READ, SCOPE_WRITE } from "../shared/api.ts"
import {
  hashHighEntropy,
  hashLowEntropy,
  newApiToken,
  normalizeUserCode,
  randomBase64,
  randomUserCode
} from "../shared/crypto.ts"
import { addDaysIso, addSecondsIso, nowIso } from "../shared/time.ts"
import { withAuth } from "./authn.ts"
import { AuthStore } from "./authStore.ts"
import { jsonBody } from "./body.ts"
import { ServerConfig } from "./config.ts"
import { errResponse, jsonResponse, requestSource } from "./http.ts"
import { RateLimiter } from "./rateLimiter.ts"
import { Redacted } from "effect"

const DEVICE_GRANT_LIFETIME_SECONDS = 10 * 60
const INITIAL_POLL_INTERVAL = 5

const DeviceCodeRequest = Schema.Struct({
  device_secret: Schema.optionalKey(Schema.String),
  device_label: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Schema.Array(Schema.String))
})

const DeviceTokenRequest = Schema.Struct({
  device_code: Schema.optionalKey(Schema.String),
  device_secret: Schema.optionalKey(Schema.String)
})

const validateScopes = (input: ReadonlyArray<string> | undefined): ReadonlyArray<string> | null => {
  if (input === undefined || input.length === 0) return [SCOPE_READ, SCOPE_WRITE]
  const seen = new Set<string>()
  for (const scope of input) {
    if (scope !== SCOPE_READ && scope !== SCOPE_WRITE) return null
    seen.add(scope)
  }
  if (!seen.has(SCOPE_READ)) return null
  return seen.has(SCOPE_WRITE) ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ]
}

const isValidDeviceSecret = (secret: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return false
  const decoded = Buffer.from(secret, "base64url")
  return decoded.length === 32 && decoded.toString("base64url") === secret
}

const deviceError = (status: number, code: string, retryAfterSeconds: number) =>
  HttpServerResponse.jsonUnsafe(
    { error: code },
    {
      status,
      contentType: "application/json; charset=utf-8",
      ...(retryAfterSeconds > 0 ? { headers: { "retry-after": String(retryAfterSeconds) } } : {})
    }
  )

const handleDeviceCode = Effect.gen(function* () {
  const config = yield* ServerConfig
  const limiter = yield* RateLimiter
  const store = yield* AuthStore
  const { sourceKey, sourceHint } = yield* requestSource(config)
  if (!(yield* limiter.allow(`create:${sourceKey}`, 5, 10 * 60 * 1000))) {
    return errResponse(429, "rate_limited")
  }
  const request = yield* jsonBody(DeviceCodeRequest)
  const secret = request.device_secret ?? ""
  if (!isValidDeviceSecret(secret)) {
    return errResponse(400, "device_secret must be 32 random bytes encoded as base64url")
  }
  const label = (request.device_label ?? "").trim()
  if (label === "" || label.length > 120) {
    return errResponse(400, "device_label must be between 1 and 120 characters")
  }
  const scopes = validateScopes(request.scopes)
  if (scopes === null) {
    return errResponse(400, "scopes must contain pages:read and optionally pages:write")
  }

  const deviceCode = yield* randomBase64(32)
  const userCode = yield* randomUserCode
  const id = yield* randomBase64(12)
  const now = yield* nowIso
  const passcode = Redacted.value(config.adminPasscode)

  const result = yield* store
    .createDeviceAuthorization(
      {
        id,
        deviceCodeHash: hashHighEntropy(deviceCode),
        deviceSecretHash: hashHighEntropy(secret),
        userCodeHash: hashLowEntropy(passcode, normalizeUserCode(userCode)),
        deviceLabel: label,
        scopes: scopes.join(" "),
        sourceKey,
        sourceHint,
        createdAt: now,
        expiresAt: addSecondsIso(now, DEVICE_GRANT_LIFETIME_SECONDS),
        pollIntervalSeconds: INITIAL_POLL_INTERVAL
      },
      5,
      50
    )
    .pipe(
      Effect.as<"ok" | "limit" | "error">("ok"),
      Effect.catchTag("GrantLimitReached", () => Effect.succeed("limit" as const)),
      Effect.catchTag("SqlError", () => Effect.succeed("error" as const))
    )
  if (result === "limit") return errResponse(429, "too_many_pending_authorizations")
  if (result === "error") return errResponse(500, "could not create device authorization")

  const verification = `${config.controlUrl}/activate`
  return jsonResponse(201, {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verification,
    verification_uri_complete: `${verification}?code=${userCode}`,
    expires_in: DEVICE_GRANT_LIFETIME_SECONDS,
    interval: INITIAL_POLL_INTERVAL
  })
})

const handleDeviceToken = Effect.gen(function* () {
  const config = yield* ServerConfig
  const limiter = yield* RateLimiter
  const store = yield* AuthStore
  const { sourceKey } = yield* requestSource(config)
  if (!(yield* limiter.allow(`poll:${sourceKey}`, 120, 10 * 60 * 1000))) {
    return errResponse(429, "rate_limited")
  }
  const request = yield* jsonBody(DeviceTokenRequest)
  const codeHash = hashHighEntropy(request.device_code ?? "")
  const secretHash = hashHighEntropy(request.device_secret ?? "")
  const now = yield* nowIso
  const minted = yield* newApiToken

  const grant = yield* store.deviceAuthorizationByDeviceCode(codeHash, secretHash, now).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchTags({
      GrantNotFound: () => Effect.succeed({ ok: false as const, response: deviceError(400, "expired_token", 0) }),
      GrantExpired: () => Effect.succeed({ ok: false as const, response: deviceError(400, "expired_token", 0) }),
      SqlError: () =>
        Effect.succeed({ ok: false as const, response: errResponse(500, "could not complete device authorization") })
    })
  )
  if (!grant.ok) return grant.response

  return yield* store
    .pollDeviceAuthorization(codeHash, secretHash, now, {
      id: minted.id,
      tokenHash: hashHighEntropy(minted.token),
      displayPrefix: minted.displayPrefix,
      deviceLabel: grant.value.deviceLabel,
      scopes: grant.value.scopes,
      createdAt: now,
      expiresAt: addDaysIso(now, config.tokenTtlDays)
    })
    .pipe(
      Effect.as(
        jsonResponse(200, {
          access_token: minted.token,
          token_type: "Bearer",
          expires_in: config.tokenTtlDays * 86400,
          scope: grant.value.scopes
        })
      ),
      Effect.catchTags({
        GrantPending: (e) => Effect.succeed(deviceError(400, "authorization_pending", e.interval)),
        SlowDown: (e) => Effect.succeed(deviceError(400, "slow_down", e.interval)),
        GrantDenied: () => Effect.succeed(deviceError(400, "access_denied", 0)),
        // A consumed grant is terminal; replay must never reveal or mint a token.
        GrantConsumed: () => Effect.succeed(deviceError(400, "expired_token", 0)),
        GrantExpired: () => Effect.succeed(deviceError(400, "expired_token", 0)),
        GrantNotFound: () => Effect.succeed(deviceError(400, "expired_token", 0)),
        SqlError: () => Effect.succeed(errResponse(500, "could not complete device authorization"))
      })
    )
})

const handleSelfRevoke = withAuth(SCOPE_READ, (credential) =>
  Effect.gen(function* () {
    if (credential.kind !== "device_token") {
      return errResponse(400, "only device tokens can revoke themselves")
    }
    const store = yield* AuthStore
    const now = yield* nowIso
    return yield* store.revokeApiToken(credential.tokenId, now).pipe(
      Effect.as(jsonResponse(200, { revoked: true })),
      Effect.catchTags({
        TokenNotFound: () => Effect.succeed(errResponse(500, "could not revoke token")),
        SqlError: () => Effect.succeed(errResponse(500, "could not revoke token"))
      })
    )
  })
)

export const DeviceAuthRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "POST",
      "/api/auth/device/code",
      handleDeviceCode.pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errResponse(400, e.message))))
    )
    yield* router.add(
      "POST",
      "/api/auth/device/token",
      handleDeviceToken.pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errResponse(400, e.message))))
    )
    yield* router.add("POST", "/api/auth/revoke", handleSelfRevoke)
  })
)
