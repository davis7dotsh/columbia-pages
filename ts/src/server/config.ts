import { Config, Context, Data, Effect, Layer, Redacted, Result } from "effect"
import { parseConfiguredOrigin, type ParsedOrigin } from "../shared/origins.ts"

export class ServerConfigError extends Data.TaggedError("ServerConfigError")<{
  readonly message: string
}> {}

export interface ServerConfigShape {
  readonly dbPath: string
  readonly port: number
  readonly adminPasscode: Redacted.Redacted<string>
  readonly tokenTtlDays: number
  readonly publicUrl: string
  readonly publicHost: string
  readonly controlUrl: string
  readonly controlHost: string
  readonly secureCookie: boolean
  readonly trustForwardedIp: boolean
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "ServerConfig"
) {}

const requiredOrigin = (name: string, value: string) =>
  Result.match(parseConfiguredOrigin(value), {
    onFailure: (message: string) =>
      Effect.fail(new ServerConfigError({ message: `${name}: ${message}` })),
    onSuccess: (parsed: ParsedOrigin | null) =>
      parsed === null
        ? Effect.fail(new ServerConfigError({ message: `${name} is required` }))
        : Effect.succeed(parsed)
  })

const make = Effect.gen(function* () {
  const dbPath = yield* Config.string("DB_PATH").pipe(Config.withDefault("./columbia-pages.db"))
  const port = yield* Config.port("PORT").pipe(Config.withDefault(8080))
  const adminPasscode = yield* Config.redacted("COLUMBIA_PAGES_ADMIN_PASSCODE").pipe(
    Config.withDefault(Redacted.make(""))
  )
  const tokenTtlDays = yield* Config.int("COLUMBIA_PAGES_TOKEN_TTL_DAYS").pipe(
    Config.withDefault(90)
  )
  const publicBase = yield* Config.string("PUBLIC_BASE_URL").pipe(Config.withDefault(""))
  const controlBase = yield* Config.string("CONTROL_BASE_URL").pipe(Config.withDefault(""))
  const railwayEnv = yield* Config.string("RAILWAY_ENVIRONMENT_ID").pipe(Config.withDefault(""))

  if (Redacted.value(adminPasscode) === "") {
    return yield* new ServerConfigError({ message: "COLUMBIA_PAGES_ADMIN_PASSCODE is required" })
  }
  const publicOrigin = yield* requiredOrigin("PUBLIC_BASE_URL", publicBase)
  const controlOrigin = yield* requiredOrigin("CONTROL_BASE_URL", controlBase)
  // Compare hosts, not just origins: routing dispatches on the Host header,
  // so two origins differing only by scheme would collapse the public/control
  // security boundary.
  if (publicOrigin.host === controlOrigin.host) {
    return yield* new ServerConfigError({
      message: "PUBLIC_BASE_URL and CONTROL_BASE_URL must use different hosts"
    })
  }
  if (tokenTtlDays < 1 || tokenTtlDays > 365) {
    return yield* new ServerConfigError({
      message: "COLUMBIA_PAGES_TOKEN_TTL_DAYS must be between 1 and 365"
    })
  }

  return {
    dbPath,
    port,
    adminPasscode,
    tokenTtlDays,
    publicUrl: publicOrigin.origin,
    publicHost: publicOrigin.host,
    controlUrl: controlOrigin.origin,
    controlHost: controlOrigin.host,
    secureCookie: controlOrigin.secure,
    trustForwardedIp: railwayEnv !== ""
  } satisfies ServerConfigShape
})

export const ServerConfigLive = Layer.effect(ServerConfig)(make)
