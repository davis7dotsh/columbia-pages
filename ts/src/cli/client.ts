import { Data, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import type { HttpMethod } from "@effect/platform/HttpMethod"

export class CliError extends Data.TaggedError("CliError")<{ readonly message: string }> {}

export interface ApiClient {
  readonly base: string
  readonly token: string
}

const fail = (message: string) => new CliError({ message })

/**
 * request issues an authenticated JSON request and decodes the response. It
 * mirrors the Go client's error surface: `server <status>: <error>` on >=400.
 */
export const request = <A = unknown>(
  c: ApiClient,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A | null, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    let req = HttpClientRequest.make(method)(c.base + path).pipe(
      HttpClientRequest.setHeader("Authorization", "Bearer " + c.token),
    )
    if (body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
        Effect.mapError((e) => fail(String(e))),
      )
    }
    const resp = yield* client.execute(req).pipe(Effect.mapError((e) => fail(e.message)))
    const text = yield* resp.text.pipe(Effect.mapError((e) => fail(e.message)))

    if (resp.status >= 400) {
      let msg = text.trim()
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (typeof parsed.error === "string" && parsed.error !== "") msg = parsed.error
      } catch {
        // fall through to the raw body text
      }
      return yield* fail(`server ${resp.status}: ${msg}`)
    }
    if (text.trim() === "") return null
    return JSON.parse(text) as A
  })

/** authCheck returns the parsed body plus HTTP status (needed by `status`). */
export const authCheck = (
  c: ApiClient,
): Effect.Effect<{ readonly status: number; readonly body: AuthInfo | null }, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = HttpClientRequest.get(c.base + "/api/auth").pipe(
      HttpClientRequest.setHeader("Authorization", "Bearer " + c.token),
    )
    const resp = yield* client.execute(req).pipe(Effect.mapError((e) => fail(e.message)))
    const text = yield* resp.text.pipe(Effect.mapError((e) => fail(e.message)))
    const body = resp.status === 200 && text.trim() !== "" ? (JSON.parse(text) as AuthInfo) : null
    return { status: resp.status, body }
  })

export interface PageResp {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly slug?: string
  readonly raw: boolean
  readonly created_at: string
  readonly updated_at: string
  readonly expires_at?: string | null
  readonly size?: number
}

export interface AuthInfo {
  readonly ok: boolean
  readonly credential_type: string
  readonly scopes: ReadonlyArray<string>
  readonly label: string
  readonly expires_at: string | null
}
