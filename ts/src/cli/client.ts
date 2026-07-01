import { Duration, Effect, Option, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AuthInfoResponse, PageResponse } from "../shared/api.ts"
import { normalizeServerUrl } from "../shared/origins.ts"
import { resolveTarget } from "./config.ts"
import { CliUserError, cliError, serverErrorMessage } from "./errors.ts"

export const normalizeOrFail = (value: string): Effect.Effect<string, CliUserError> =>
  Result.match(normalizeServerUrl(value), {
    onFailure: (message: string): Effect.Effect<string, CliUserError> =>
      Effect.fail(cliError(message)),
    onSuccess: (normalized: string): Effect.Effect<string, CliUserError> =>
      Effect.succeed(normalized)
  })

type Method = "GET" | "POST" | "PUT" | "DELETE"

// makeClient resolves and validates the target server + token, then returns
// a small JSON-over-HTTP client mirroring the Go CLI's `client.do`.
export const makeClient = (serverFlag: string) =>
  Effect.gen(function* () {
    const target = yield* resolveTarget(serverFlag)
    if (target.server === "") {
      return yield* cliError("no server configured — run `cpages login`")
    }
    const base = yield* normalizeOrFail(target.server)
    if (target.token === "") {
      return yield* cliError("not logged in — run `cpages login`")
    }
    const http = yield* HttpClient.HttpClient

    const request = (method: Method, path: string, body?: unknown) =>
      Effect.gen(function* () {
        let req = HttpClientRequest.make(method)(base + path).pipe(
          HttpClientRequest.bearerToken(target.token)
        )
        if (body !== undefined) {
          req = req.pipe(HttpClientRequest.bodyJsonUnsafe(body))
        }
        const response = yield* http.execute(req).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError((error) => cliError(String(error)))
        )
        const text = yield* response.text.pipe(Effect.mapError((error) => cliError(String(error))))
        if (response.status >= 400) {
          return yield* cliError(serverErrorMessage(response.status, text))
        }
        if (text === "") return null
        return yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) => cliError(`decode response: ${error}`)
        })
      })

    return { base, token: target.token, request } as const
  })

export const decodePage = (value: unknown) =>
  Schema.decodeUnknownEffect(PageResponse)(value).pipe(
    Effect.mapError((error): CliUserError => cliError(`decode response: ${error}`))
  )

export const decodePageList = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({ pages: Schema.optionalKey(Schema.NullOr(Schema.Array(PageResponse))) })
  )(value).pipe(
    Effect.map((decoded) => decoded.pages ?? []),
    Effect.mapError((error): CliUserError => cliError(`decode response: ${error}`))
  )

// authInfo mirrors the Go client's authInfo: 200 → parsed metadata; any other
// status is reported by code so `status` can explain what happened.
export const authInfo = (base: string, token: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${base}/api/auth`).pipe(HttpClientRequest.bearerToken(token))
      )
      .pipe(Effect.timeout(Duration.seconds(15)), Effect.mapError((error) => cliError(String(error))))
    if (response.status !== 200) {
      return { status: response.status, info: Option.none<AuthInfoResponse>() }
    }
    const json = yield* response.json.pipe(Effect.mapError((error) => cliError(String(error))))
    const info = yield* Schema.decodeUnknownEffect(AuthInfoResponse)(json).pipe(
      Effect.mapError((error) => cliError(`decode response: ${error}`))
    )
    return { status: response.status, info: Option.some(info) }
  })
