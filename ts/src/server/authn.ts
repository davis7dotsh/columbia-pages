import { Data, Effect } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http"
import { hashHighEntropy } from "../shared/crypto.ts"
import { nowIso } from "../shared/time.ts"
import { AuthStore } from "./authStore.ts"
import { ServerConfig } from "./config.ts"
import { bearerToken, errResponse, isControlHost } from "./http.ts"

export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}

export interface Credential {
  readonly kind: string
  readonly tokenId: string
  readonly label: string
  readonly scopes: ReadonlyArray<string>
  readonly expiresAt: string | null
}

// Device tokens are only ever accepted on the control origin; the content
// origin serves public pages and must never see credentials.
const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* AuthStore
  const token = bearerToken(request)
  if (token === "" || !isControlHost(config, request)) {
    return yield* new Unauthorized()
  }
  const now = yield* nowIso
  const stored = yield* store
    .apiTokenByHash(hashHighEntropy(token), now)
    .pipe(Effect.mapError(() => new Unauthorized()))
  const staleBefore = new Date(Date.parse(now) - 5 * 60 * 1000).toISOString()
  if (stored.lastUsedAt === null || stored.lastUsedAt < staleBefore) {
    yield* store.touchApiToken(stored.id, now).pipe(Effect.ignore)
  }
  return {
    kind: "device_token",
    tokenId: stored.id,
    label: stored.deviceLabel,
    scopes: stored.scopes.split(/\s+/).filter((scope) => scope !== ""),
    expiresAt: stored.expiresAt
  } satisfies Credential
})

// withAuth is the equivalent of the Go server's s.auth(scope, handler)
// wrapper: 401 for any authentication failure, 403 for missing scope.
export const withAuth = <E, R>(
  scope: string,
  handler: (credential: Credential) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  authenticate.pipe(
    Effect.flatMap((credential) =>
      credential.scopes.includes(scope)
        ? handler(credential)
        : Effect.succeed(errResponse(403, "insufficient_scope"))
    ),
    Effect.catchTag("Unauthorized", () => Effect.succeed(errResponse(401, "unauthorized")))
  )
