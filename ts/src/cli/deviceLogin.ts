import { hostname } from "node:os"
import { Clock, Config, Console, Duration, Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/cli"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  DeviceCodeResponse,
  DeviceTokenResponse,
  DiscoveryResponse,
  SCOPE_READ,
  SCOPE_WRITE
} from "../shared/api.ts"
import { randomBase64 } from "../shared/crypto.ts"
import { normalizeOrFail } from "./client.ts"
import { CliConfig } from "./config.ts"
import { CliUserError, cliError, serverErrorMessage } from "./errors.ts"

const messageOf = (error: unknown): string =>
  error instanceof CliUserError ? error.message : String(error)

const discover = (http: HttpClient.HttpClient, server: string) =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(`${server}/.well-known/columbia-pages`)
    )
    if (response.status !== 200) {
      return yield* cliError(`server returned HTTP ${response.status}`)
    }
    const json = yield* response.json
    return yield* Schema.decodeUnknownEffect(DiscoveryResponse)(json)
  }).pipe(Effect.timeout(Duration.seconds(15)))

const requestDeviceCode = (
  http: HttpClient.HttpClient,
  controlUrl: string,
  secret: string,
  label: string,
  scopes: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.post(`${controlUrl}/api/auth/device/code`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          device_secret: secret,
          device_label: label,
          scopes
        })
      )
    )
    const text = yield* response.text
    if (response.status !== 201) {
      return yield* cliError(serverErrorMessage(response.status, text))
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => cliError(messageOf(e))
    })
    const code = yield* Schema.decodeUnknownEffect(DeviceCodeResponse)(parsed)
    if (
      code.device_code === "" ||
      code.user_code === "" ||
      code.verification_uri === "" ||
      code.expires_in <= 0
    ) {
      return yield* cliError("server returned an incomplete device authorization response")
    }
    return code.interval < 1 ? { ...code, interval: 5 } : code
  }).pipe(
    Effect.timeout(Duration.seconds(15)),
    Effect.mapError((e) => (e instanceof CliUserError ? e : cliError(messageOf(e))))
  )

const pollDeviceToken = (
  http: HttpClient.HttpClient,
  controlUrl: string,
  code: typeof DeviceCodeResponse.Type,
  secret: string
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const deadline = start + code.expires_in * 1000
    let interval = code.interval
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const poll = yield* Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.post(`${controlUrl}/api/auth/device/token`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              device_code: code.device_code,
              device_secret: secret
            })
          )
        )
        const json = yield* response.json
        const result = yield* Schema.decodeUnknownEffect(DeviceTokenResponse)(json)
        return { response, result }
      }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.mapError((e) => (e instanceof CliUserError ? e : cliError(messageOf(e))))
      )
      const { response, result } = poll
      const accessToken = result.access_token ?? ""
      if (response.status === 200 && accessToken !== "") return accessToken
      switch (result.error ?? "") {
        case "authorization_pending":
          break
        case "slow_down": {
          const retryAfter = Number(response.headers["retry-after"] ?? "")
          if (Number.isFinite(retryAfter) && retryAfter > interval) interval = retryAfter
          else interval += 5
          break
        }
        case "access_denied":
          return yield* cliError("device authorization was denied")
        case "expired_token":
          return yield* cliError("device authorization expired")
        default:
          return yield* cliError(`device authorization failed: ${result.error ?? ""}`)
      }
      yield* Effect.sleep(Duration.seconds(interval))
    }
    return yield* cliError("device authorization expired")
  })

export const loginWithDevice = (
  serverFlag: Option.Option<string>,
  deviceNameFlag: Option.Option<string>,
  readOnly: boolean
) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig
    const http = yield* HttpClient.HttpClient
    const existing = yield* cliConfig.load

    const envUrl = yield* Config.string("COLUMBIA_PAGES_URL").pipe(
      Config.withDefault(""),
      Effect.mapError((e) => cliError(String(e)))
    )
    let server = Option.getOrElse(serverFlag, () => "").trim()
    if (server === "") server = envUrl.trim()
    if (server === "") {
      const hint = existing.url !== "" ? ` [${existing.url}]` : ""
      const entered = yield* Prompt.text({
        message: `Server URL${hint}:`,
        ...(existing.url !== "" ? { default: existing.url } : {})
      }).pipe(Effect.mapError(() => cliError("login cancelled")))
      server = entered.trim() !== "" ? entered : existing.url
    }
    const normalizedServer = yield* normalizeOrFail(server)

    const discovery = yield* discover(http, normalizedServer).pipe(
      Effect.mapError((e) =>
        cliError(
          `device discovery failed: ${messageOf(e)}; upgrade the Columbia Pages deployment, then retry`
        )
      )
    )
    if (!discovery.device_authorization || discovery.control_url === "") {
      return yield* cliError(
          "this instance does not support device login; upgrade the Columbia Pages deployment, then retry"
        )
    }
    const controlUrl = yield* normalizeOrFail(discovery.control_url).pipe(
      Effect.mapError((e) => cliError(`server returned an unsafe control URL: ${e.message}`))
    )

    let deviceName = Option.getOrElse(deviceNameFlag, () => "")
    if (deviceName === "") {
      const host = hostname().trim()
      deviceName = `cpages on ${host !== "" ? host : "this device"}`
    }
    if (deviceName.length > 120) {
      return yield* cliError("--device-name must be 120 characters or fewer")
    }

    const secret = yield* randomBase64(32)
    const scopes = readOnly ? [SCOPE_READ] : [SCOPE_READ, SCOPE_WRITE]
    const code = yield* requestDeviceCode(http, controlUrl, secret, deviceName, scopes)

    yield* Console.log(
      `Open this URL to approve the device:\n${code.verification_uri_complete}\n\nCode: ${code.user_code}\n\nWaiting for approval...`
    )
    const token = yield* pollDeviceToken(http, controlUrl, code, secret)

    yield* cliConfig.save({ url: controlUrl, token })
    yield* Console.log(`✓ Logged in to ${controlUrl}`)
    yield* Console.log(`  saved to ${cliConfig.path}`)
  })
