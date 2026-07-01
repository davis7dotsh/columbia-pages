import { Data, Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import type { HttpServerResponse } from "effect/unstable/http"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { hashHighEntropy } from "../internal/crypto.ts"
import { NotFound } from "../store/models.ts"
import { Store } from "../store/Store.ts"
import { CurrentTime, ServerConfig } from "./Config.ts"
import { bearerToken, errJson, hasScope, hostOf, splitScopes } from "./util.ts"

export interface Credential {
  readonly kind: string
  readonly tokenId: string
  readonly label: string
  readonly scopes: ReadonlyArray<string>
  readonly expiresAt: Date | null
}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}

/** authenticate verifies the bearer token on the control origin. */
export const authenticate = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const clock = yield* CurrentTime

  const token = bearerToken(req)
  if (token === "") return yield* new Unauthorized()
  if (hostOf(req).toLowerCase() !== config.controlHost.toLowerCase()) return yield* new Unauthorized()

  const nowDate = clock.now()
  const stored = yield* store.apiTokenByHash(hashHighEntropy(token), nowDate).pipe(
    Effect.catchTag("NotFound", () => new Unauthorized()),
  )
  if (stored.lastUsedAt === null || stored.lastUsedAt.getTime() < nowDate.getTime() - 5 * 60 * 1000) {
    yield* store.touchAPIToken(stored.id, nowDate).pipe(Effect.ignore)
  }
  const credential: Credential = {
    kind: "device_token",
    tokenId: stored.id,
    label: stored.deviceLabel,
    scopes: splitScopes(stored.scopes),
    expiresAt: stored.expiresAt,
  }
  return credential
})

/**
 * withAuth authenticates, enforces `scope`, and runs `next` with the credential.
 * Auth failures become 401; scope failures become 403.
 */
export const withAuth = <R>(
  scope: string,
  next: (credential: Credential) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  SqlError,
  R | HttpServerRequest.HttpServerRequest | ServerConfig | Store | CurrentTime
> =>
  authenticate.pipe(
    Effect.flatMap((credential) =>
      hasScope(credential.scopes, scope)
        ? next(credential)
        : Effect.succeed(errJson(403, "insufficient_scope")),
    ),
    Effect.catchTag("Unauthorized", () => Effect.succeed(errJson(401, "unauthorized"))),
  )
