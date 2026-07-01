import { homedir } from "node:os"
import { join } from "node:path"
import { Config, Context, Effect, FileSystem, Layer, Schema } from "effect"
import { CliUserError, cliError } from "./errors.ts"

// The persisted CLI login. Saved to config.json with mode 0600 — it holds a
// device token.
export interface CliConfigData {
  readonly url: string
  readonly token: string
}

const StoredConfig = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  token: Schema.optionalKey(Schema.String)
})

// $COLUMBIA_PAGES_CONFIG_DIR, else $XDG_CONFIG_HOME/columbia-pages,
// else ~/.config/columbia-pages
const configDir = Effect.gen(function* () {
  const explicit = yield* Config.string("COLUMBIA_PAGES_CONFIG_DIR").pipe(Config.withDefault(""))
  if (explicit !== "") return explicit
  const xdg = yield* Config.string("XDG_CONFIG_HOME").pipe(Config.withDefault(""))
  if (xdg !== "") return join(xdg, "columbia-pages")
  return join(homedir(), ".config", "columbia-pages")
})

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* configDir.pipe(Effect.mapError((e) => cliError(String(e))))
  const path = join(dir, "config.json")

  // A missing file yields an empty config, so callers can treat "not logged
  // in" as empty fields.
  const load: Effect.Effect<CliConfigData, CliUserError> = Effect.gen(function* () {
    const present = yield* fs.exists(path).pipe(Effect.mapError((e) => cliError(String(e))))
    if (!present) return { url: "", token: "" }
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((e) => cliError(`read ${path}: ${e}`)))
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => cliError(`parse ${path}: ${e}`)
    })
    const decoded = yield* Schema.decodeUnknownEffect(StoredConfig)(parsed).pipe(
      Effect.mapError((e) => cliError(`parse ${path}: ${e}`))
    )
    return { url: decoded.url ?? "", token: decoded.token ?? "" }
  })

  const save = (config: CliConfigData) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.chmod(dir, 0o700)
      const body =
        JSON.stringify(
          { url: config.url, ...(config.token !== "" ? { token: config.token } : {}) },
          null,
          2
        ) + "\n"
      yield* fs.writeFileString(path, body)
      yield* fs.chmod(path, 0o600)
    }).pipe(Effect.mapError((e) => cliError(`write ${path}: ${e}`)))

  // Returns false when there was nothing to remove.
  const remove: Effect.Effect<boolean, CliUserError> = Effect.gen(function* () {
    const present = yield* fs.exists(path)
    if (!present) return false
    yield* fs.remove(path)
    return true
  }).pipe(Effect.mapError((e) => cliError(String(e))))

  return { path, load, save, remove } as const
})

export class CliConfig extends Context.Service<CliConfig>()("CliConfig", { make }) {}

export const CliConfigLive = Layer.effect(CliConfig)(CliConfig.make)

export interface ResolvedTarget {
  readonly server: string
  readonly token: string
  readonly serverSource: string
  readonly tokenSource: string
}

// Flag → env → config for the server; env token → saved token.
export const resolveTarget = (serverFlag: string) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig
    const stored = yield* cliConfig.load
    const envUrl = yield* Config.string("COLUMBIA_PAGES_URL").pipe(
      Config.withDefault(""),
      Effect.mapError((e) => cliError(String(e)))
    )
    const envToken = yield* Config.string("COLUMBIA_PAGES_TOKEN").pipe(
      Config.withDefault(""),
      Effect.mapError((e) => cliError(String(e)))
    )

    let server = ""
    let serverSource = ""
    if (serverFlag.trim() !== "") {
      server = serverFlag
      serverSource = "flag"
    } else if (envUrl !== "") {
      server = envUrl
      serverSource = "env"
    } else if (stored.url !== "") {
      server = stored.url
      serverSource = "config"
    }

    let token = ""
    let tokenSource = ""
    if (envToken !== "") {
      token = envToken
      tokenSource = "env"
    } else if (stored.token !== "") {
      token = stored.token
      tokenSource = "config"
    }

    return {
      server: server.trim().replace(/\/+$/, ""),
      token: token.trim(),
      serverSource,
      tokenSource
    } satisfies ResolvedTarget
  })
