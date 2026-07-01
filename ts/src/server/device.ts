import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  hashHighEntropy,
  hashLowEntropy,
  newAPIToken,
  normalizeUserCode,
  randomBase64,
  randomUserCode,
} from "../internal/crypto.ts"
import type { APIToken, DeviceAuthorization } from "../store/models.ts"
import { Store } from "../store/Store.ts"
import type { Credential } from "./auth.ts"
import { CurrentTime, Limiter, ServerConfig } from "./Config.ts"
import { BadRequest, decodeBody } from "./decode.ts"
import { errJson, json, requestSource, validateScopes } from "./util.ts"

const deviceGrantLifetimeMs = 10 * 60 * 1000
const initialPollInterval = 5

/** Strictly validates raw (unpadded) base64url of exactly 32 bytes. */
const validDeviceSecret = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  const decoded = Buffer.from(value, "base64url")
  if (decoded.length !== 32) return false
  return decoded.toString("base64url") === value
}

const deviceError = (
  status: number,
  code: string,
  retry: number,
): HttpServerResponse.HttpServerResponse => {
  const res = json(status, { error: code })
  return retry > 0 ? HttpServerResponse.setHeader(res, "Retry-After", String(retry)) : res
}

export const handleDiscovery = Effect.gen(function* () {
  const config = yield* ServerConfig
  return json(200, {
    control_url: config.controlURL,
    content_url: config.baseURL,
    device_authorization: true,
  })
})

export const handleDeviceCode = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const limiter = yield* Limiter
  const clock = yield* CurrentTime
  const req = yield* HttpServerRequest.HttpServerRequest

  const [sourceKey, sourceHint] = requestSource(req, config)
  if (!limiter.allow("create:" + sourceKey, 5, deviceGrantLifetimeMs, clock.now())) {
    return errJson(429, "rate_limited")
  }
  const body = yield* decodeBody(["device_secret", "device_label", "scopes"])

  const deviceSecret = typeof body.device_secret === "string" ? body.device_secret : ""
  if (!validDeviceSecret(deviceSecret)) {
    return errJson(400, "device_secret must be 32 random bytes encoded as base64url")
  }
  const label = (typeof body.device_label === "string" ? body.device_label : "").trim()
  if (label === "" || label.length > 120) {
    return errJson(400, "device_label must be between 1 and 120 characters")
  }
  const scopesInput = Array.isArray(body.scopes) ? (body.scopes as ReadonlyArray<string>) : []
  const [scopes, ok] = validateScopes(scopesInput)
  if (!ok) return errJson(400, "scopes must contain pages:read and optionally pages:write")

  const deviceCode = randomBase64(32)
  const userCode = randomUserCode()
  const id = randomBase64(12)
  const now = clock.now()
  const grant: DeviceAuthorization = {
    id,
    deviceCodeHash: hashHighEntropy(deviceCode),
    deviceSecretHash: hashHighEntropy(deviceSecret),
    userCodeHash: hashLowEntropy(config.adminPasscode, normalizeUserCode(userCode)),
    deviceLabel: label,
    scopes: scopes.join(" "),
    sourceKey,
    sourceHint,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + deviceGrantLifetimeMs),
    approvedAt: null,
    deniedAt: null,
    lastPollAt: null,
    pollIntervalSeconds: initialPollInterval,
    consumedAt: null,
  }

  const created = yield* store.createDeviceAuthorization(grant, 5, 50).pipe(
    Effect.map(() => ({ ok: true as const })),
    Effect.catchTag("LimitReached", () => Effect.succeed({ ok: false as const, status: 429, code: "too_many_pending_authorizations" })),
    Effect.orElseSucceed(() => ({ ok: false as const, status: 500, code: "could not create device authorization" })),
  )
  if (!created.ok) return errJson(created.status, created.code)

  const verification = config.controlURL + "/activate"
  return json(201, {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verification,
    verification_uri_complete: verification + "?code=" + userCode,
    expires_in: Math.floor(deviceGrantLifetimeMs / 1000),
    interval: initialPollInterval,
  })
}).pipe(Effect.catchTag("BadRequest", (e: BadRequest) => Effect.succeed(errJson(400, e.message))))

export const handleDeviceToken = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const limiter = yield* Limiter
  const clock = yield* CurrentTime
  const req = yield* HttpServerRequest.HttpServerRequest

  const [sourceKey] = requestSource(req, config)
  if (!limiter.allow("poll:" + sourceKey, 120, deviceGrantLifetimeMs, clock.now())) {
    return errJson(429, "rate_limited")
  }
  const body = yield* decodeBody(["device_code", "device_secret"])
  const deviceCode = typeof body.device_code === "string" ? body.device_code : ""
  const deviceSecret = typeof body.device_secret === "string" ? body.device_secret : ""

  const [rawToken, tokenId, displayPrefix] = newAPIToken()
  const now = clock.now()
  const codeHash = hashHighEntropy(deviceCode)
  const secretHash = hashHighEntropy(deviceSecret)

  const lookup = yield* store.deviceAuthorizationByDeviceCode(codeHash, secretHash, now).pipe(
    Effect.map((g) => ({ ok: true as const, g })),
    Effect.catchTags({
      GrantExpired: () => Effect.succeed({ ok: false as const, status: 400, code: "expired_token" }),
      GrantNotFound: () => Effect.succeed({ ok: false as const, status: 400, code: "expired_token" }),
    }),
    Effect.orElseSucceed(() => ({ ok: false as const, status: 500, code: "could not complete device authorization" })),
  )
  if (!lookup.ok) return errJson(lookup.status, lookup.code)
  const grant = lookup.g

  const token: APIToken = {
    id: tokenId,
    tokenHash: hashHighEntropy(rawToken),
    displayPrefix,
    deviceLabel: grant.deviceLabel,
    scopes: grant.scopes,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.tokenTTLDays * 24 * 60 * 60 * 1000),
    lastUsedAt: null,
    revokedAt: null,
  }

  return yield* store.pollDeviceAuthorization(codeHash, secretHash, now, token).pipe(
    Effect.as(
      json(200, {
        access_token: rawToken,
        token_type: "Bearer",
        expires_in: config.tokenTTLDays * 86400,
        scope: grant.scopes,
      }),
    ),
    Effect.catchTags({
      GrantPending: (e) => Effect.succeed(deviceError(400, "authorization_pending", e.interval)),
      SlowDown: (e) => Effect.succeed(deviceError(400, "slow_down", e.interval)),
      GrantDenied: () => Effect.succeed(deviceError(400, "access_denied", 0)),
      GrantConsumed: () => Effect.succeed(deviceError(400, "expired_token", 0)),
      GrantExpired: () => Effect.succeed(deviceError(400, "expired_token", 0)),
      GrantNotFound: () => Effect.succeed(deviceError(400, "expired_token", 0)),
    }),
    Effect.orElseSucceed(() => errJson(500, "could not complete device authorization")),
  )
}).pipe(Effect.catchTag("BadRequest", (e: BadRequest) => Effect.succeed(errJson(400, e.message))))

export const handleSelfRevoke = (
  credential: Credential,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Store | CurrentTime> =>
  Effect.gen(function* () {
    const store = yield* Store
    const clock = yield* CurrentTime
    if (credential.kind !== "device_token") {
      return errJson(400, "only device tokens can revoke themselves")
    }
    return yield* store.revokeAPIToken(credential.tokenId, clock.now()).pipe(
      Effect.as(json(200, { revoked: true })),
      Effect.orElseSucceed(() => errJson(500, "could not revoke token")),
    )
  })
