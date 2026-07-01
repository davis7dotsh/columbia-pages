import { randomBytes } from "node:crypto"
import * as os from "node:os"
import { Console, Duration, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { normalizeServerURL } from "../internal/origin.ts"
import { CliError } from "./client.ts"
import { configPath, saveConfig } from "./config.ts"

const fail = (message: string) => new CliError({ message })

interface Discovery {
  readonly control_url: string
  readonly content_url: string
  readonly device_authorization: boolean
}

interface DeviceCode {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly expires_in: number
  readonly interval: number
}

const randomDeviceSecret = (): string => randomBytes(32).toString("base64url")

const postJson = (url: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const req = yield* HttpClientRequest.bodyJson(body)(HttpClientRequest.post(url)).pipe(
      Effect.mapError((e) => fail(String(e))),
    )
    const resp = yield* client.execute(req).pipe(Effect.mapError((e) => fail(e.message)))
    const text = yield* resp.text.pipe(Effect.mapError((e) => fail(e.message)))
    return { status: resp.status, text, retryAfter: resp.headers["retry-after"] ?? "" }
  })

const responseError = (status: number, text: string): CliError => {
  let msg = text.trim()
  try {
    const parsed = JSON.parse(text) as { error?: string }
    if (typeof parsed.error === "string" && parsed.error !== "") msg = parsed.error
  } catch {
    // keep raw text
  }
  return fail(`server ${status}: ${msg}`)
}

const discover = (server: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const resp = yield* client
      .execute(HttpClientRequest.get(server + "/.well-known/columbia-pages"))
      .pipe(Effect.mapError((e) => fail(e.message)))
    if (resp.status !== 200) return yield* fail(`server returned HTTP ${resp.status}`)
    const text = yield* resp.text.pipe(Effect.mapError((e) => fail(e.message)))
    return JSON.parse(text) as Discovery
  })

const requestDeviceCode = (controlURL: string, secret: string, label: string, scopes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { status, text } = yield* postJson(controlURL + "/api/auth/device/code", {
      device_secret: secret,
      device_label: label,
      scopes,
    })
    if (status !== 201) return yield* responseError(status, text)
    const code = JSON.parse(text) as DeviceCode
    if (code.device_code === "" || code.user_code === "" || code.verification_uri === "" || code.expires_in <= 0) {
      return yield* fail("server returned an incomplete device authorization response")
    }
    return { ...code, interval: code.interval < 1 ? 5 : code.interval }
  })

const pollDeviceToken = (controlURL: string, code: DeviceCode, secret: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + code.expires_in * 1000
    let interval = code.interval
    while (Date.now() < deadline) {
      const { status, text, retryAfter } = yield* postJson(controlURL + "/api/auth/device/token", {
        device_code: code.device_code,
        device_secret: secret,
      })
      const result = JSON.parse(text) as { access_token?: string; error?: string }
      if (status === 200 && result.access_token) return result.access_token
      switch (result.error) {
        case "authorization_pending":
          break
        case "slow_down": {
          const retry = Number.parseInt(retryAfter, 10)
          if (Number.isInteger(retry) && retry > interval) interval = retry
          else interval += 5
          break
        }
        case "access_denied":
          return yield* fail("device authorization was denied")
        case "expired_token":
          return yield* fail("device authorization expired")
        default:
          return yield* fail(`device authorization failed: ${result.error ?? ""}`)
      }
      yield* Effect.sleep(Duration.seconds(interval))
    }
    return yield* fail("device authorization expired")
  })

export const loginWithDevice = (
  serverValue: string,
  deviceName: string,
  readOnly: boolean,
): Effect.Effect<void, CliError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const initial = serverValue.trim() !== "" ? serverValue : process.env["COLUMBIA_PAGES_URL"] ?? ""
    if (initial.trim() === "") {
      return yield* fail("server URL is required (pass --server or set COLUMBIA_PAGES_URL)")
    }
    const server = yield* Effect.try({
      try: () => normalizeServerURL(initial),
      catch: (e) => fail((e as Error).message),
    })

    const discovery = yield* discover(server).pipe(
      Effect.mapError((e) => fail(`device discovery failed: ${e.message}; upgrade the Columbia Pages deployment, then retry`)),
    )
    if (!discovery.device_authorization || discovery.control_url === "") {
      return yield* fail("this instance does not support device login; upgrade the Columbia Pages deployment, then retry")
    }
    const controlURL = yield* Effect.try({
      try: () => normalizeServerURL(discovery.control_url),
      catch: (e) => fail(`server returned an unsafe control URL: ${(e as Error).message}`),
    })

    let label = deviceName
    if (label === "") {
      const host = os.hostname().trim()
      label = "cpages on " + (host === "" ? "this device" : host)
    }
    if (label.length > 120) return yield* fail("--device-name must be 120 characters or fewer")

    const secret = randomDeviceSecret()
    const scopes = readOnly ? ["pages:read"] : ["pages:read", "pages:write"]
    const code = yield* requestDeviceCode(controlURL, secret, label, scopes)

    yield* Console.log(
      `Open this URL to approve the device:\n${code.verification_uri_complete}\n\nCode: ${code.user_code}\n\nWaiting for approval...`,
    )
    const token = yield* pollDeviceToken(controlURL, code, secret)
    yield* Effect.try({ try: () => saveConfig({ url: controlURL, token }), catch: (e) => fail((e as Error).message) })
    yield* Console.log(`\u2713 Logged in to ${controlURL}\n  saved to ${configPath()}`)
  })
