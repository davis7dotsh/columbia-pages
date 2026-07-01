// Command cpages is the Columbia Pages client. It uploads an HTML file to the
// server and prints back a shareable link, and manages existing pages.
//
// Configuration (environment variables, overridable with flags):
//
//	COLUMBIA_PAGES_URL    server base URL, e.g. https://pages.example.com
//	COLUMBIA_PAGES_TOKEN  device token override
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Stdio,
  Stream
} from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { formatLocalMinute, formatLocalRfc3339, renderTable, truncate } from "../shared/format.ts"
import { authInfo, decodePage, decodePageList, makeClient, normalizeOrFail } from "./client.ts"
import { CliConfig, CliConfigLive, resolveTarget } from "./config.ts"
import { loginWithDevice } from "./deviceLogin.ts"
import { SilentExit, cliError } from "./errors.ts"
import { normalizePage, printJson, report } from "./output.ts"

const VERSION = "0.1.0"

const serverFlag = Flag.optional(
  Flag.string("server").pipe(Flag.withDescription("server base URL (overrides saved login)"))
)
const serverValue = (flag: Option.Option<string>) => Option.getOrElse(flag, () => "")

// readInput reads a file, or stdin when path is "-".
const readInput = (path: string) =>
  path === "-"
    ? Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio
        return yield* Stream.decodeText(stdio.stdin).pipe(
          Stream.mkString,
          Effect.mapError((e) => cliError(String(e)))
        )
      })
    : Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString(path).pipe(Effect.mapError((e) => cliError(String(e))))
      })

// --- setup commands ----------------------------------------------------------

const login = Command.make(
  "login",
  {
    server: serverFlag,
    deviceName: Flag.optional(
      Flag.string("device-name").pipe(
        Flag.withDescription("label shown to the owner during approval")
      )
    ),
    readOnly: Flag.boolean("read-only").pipe(Flag.withDescription("request only pages:read"))
  },
  (config) => loginWithDevice(config.server, config.deviceName, config.readOnly)
).pipe(Command.withDescription("authorize this device via browser approval"))

const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig
    const http = yield* HttpClient.HttpClient
    const stored = yield* cliConfig.load

    let revokeError: string | null = null
    if (stored.url !== "" && stored.token !== "") {
      revokeError = yield* Effect.gen(function* () {
        const base = yield* normalizeOrFail(stored.url)
        const response = yield* http
          .execute(
            HttpClientRequest.post(`${base}/api/auth/revoke`).pipe(
              HttpClientRequest.bearerToken(stored.token),
              HttpClientRequest.bodyJsonUnsafe({})
            )
          )
          .pipe(Effect.timeout(Duration.seconds(30)), Effect.mapError((e) => cliError(String(e))))
        if (response.status >= 400) {
          return yield* cliError(`server ${response.status}`)
        }
      }).pipe(
        Effect.match({
          onFailure: (e) => e.message,
          onSuccess: (): string | null => null
        })
      )
    }

    const removed = yield* cliConfig.remove
    if (!removed) {
      yield* Console.log("Already logged out.")
      return
    }
    yield* Console.log(`✓ Logged out (removed ${cliConfig.path})`)
    if (revokeError !== null) {
      yield* Console.error(
        `warning: local credentials were removed, but server-side revocation could not be confirmed: ${revokeError}`
      )
    }
  })
).pipe(Command.withDescription("revoke device token and forget credentials"))

const status = Command.make("status", { server: serverFlag }, ({ server }) =>
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig
    const target = yield* resolveTarget(serverValue(server))

    yield* Console.log(`Config file: ${cliConfig.path}`)
    if (target.server === "") {
      yield* Console.log("Server:      (not set) — run `cpages login`")
    } else {
      yield* Console.log(`Server:      ${target.server} (from ${target.serverSource})`)
    }
    if (target.token === "") {
      yield* Console.log("Credential:  (not set) — run `cpages login`")
    } else {
      yield* Console.log(`Credential:  device token (from ${target.tokenSource})`)
    }
    if (target.server === "" || target.token === "") {
      return yield* cliError("authentication is not configured")
    }
    const base = yield* normalizeOrFail(target.server)

    const checked = yield* authInfo(base, target.token).pipe(
      Effect.match({
        onFailure: (e) => ({ kind: "unreachable" as const, message: e.message }),
        onSuccess: (r) => ({ kind: "ok" as const, status: r.status, info: r.info })
      })
    )
    if (checked.kind === "unreachable") {
      yield* Console.log(`Auth:        could not reach server (${checked.message})`)
      return yield* cliError("server is unreachable")
    }
    if (checked.status === 200) {
      yield* Console.log("Auth:        ✓ authenticated")
      if (Option.isSome(checked.info)) {
        const info = checked.info.value
        let credentialType = (info.credential_type ?? "").replaceAll("_", " ")
        if (credentialType === "") credentialType = "device token"
        yield* Console.log(`Type:        ${credentialType}`)
        if ((info.label ?? "") !== "") yield* Console.log(`Label:       ${info.label}`)
        const scopes = info.scopes ?? []
        if (scopes.length > 0) yield* Console.log(`Scopes:      ${scopes.join(", ")}`)
        if (info.expires_at !== null && info.expires_at !== undefined) {
          yield* Console.log(`Expires:     ${formatLocalRfc3339(info.expires_at)}`)
        }
      }
      return
    }
    if (checked.status === 401) {
      yield* Console.log("Auth:        ✗ device token rejected, revoked, or expired")
      return yield* cliError("device token authentication failed")
    }
    yield* Console.log(`Auth:        unexpected HTTP ${checked.status}`)
    return yield* cliError(`authentication check returned HTTP ${checked.status}`)
  })
).pipe(
  Command.withDescription("verify authentication and show token metadata"),
  Command.withAlias("whoami")
)

// --- page commands -----------------------------------------------------------

const create = Command.make(
  "create",
  {
    title: Flag.string("title").pipe(Flag.withDescription("page title (required)")),
    slug: Flag.string("slug").pipe(Flag.withDefault(""), Flag.withDescription("optional human label")),
    raw: Flag.boolean("raw").pipe(
      Flag.withDescription("serve as a complete HTML document (no house theme)")
    ),
    ttl: Flag.integer("ttl").pipe(
      Flag.withDefault(0),
      Flag.withDescription("auto-delete after N days (0 = never)")
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print the raw JSON response")),
    server: serverFlag,
    file: Argument.string("file").pipe(Argument.withDescription("HTML file, or - for stdin"))
  },
  (config) =>
    Effect.gen(function* () {
      if (config.title.trim() === "") {
        return yield* cliError("--title is required")
      }
      const html = yield* readInput(config.file)
      const client = yield* makeClient(serverValue(config.server))
      const response = yield* client.request("POST", "/api/pages", {
        title: config.title,
        slug: config.slug,
        html,
        raw: config.raw,
        ttl_days: config.ttl
      })
      const page = yield* decodePage(response)
      yield* report(page, config.json, "Published")
    })
).pipe(Command.withDescription("publish a page"))

const list = Command.make(
  "list",
  {
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(50),
      Flag.withDescription("max pages to show (0 = all)")
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print the raw JSON response")),
    server: serverFlag
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* makeClient(serverValue(config.server))
      const response = yield* client.request("GET", `/api/pages?limit=${config.limit}`)
      const pages = yield* decodePageList(response)
      if (config.json) {
        yield* printJson(pages.map(normalizePage))
        return
      }
      if (pages.length === 0) {
        yield* Console.log("No pages yet.")
        return
      }
      const rows = [
        ["ID", "TITLE", "CREATED", "EXPIRES", "URL"],
        ...pages.map((page) => [
          page.id,
          truncate(page.title, 32),
          formatLocalMinute(page.created_at),
          page.expires_at !== null && page.expires_at !== undefined
            ? formatLocalMinute(page.expires_at)
            : "—",
          page.url
        ])
      ]
      yield* Console.log(renderTable(rows))
    })
).pipe(Command.withDescription("list pages"), Command.withAlias("ls"))

const get = Command.make(
  "get",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("print the raw JSON response")),
    server: serverFlag,
    id: Argument.string("id")
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* makeClient(serverValue(config.server))
      const response = yield* client.request("GET", `/api/pages/${config.id}`)
      const page = yield* decodePage(response)
      yield* report(page, config.json, "")
    })
).pipe(Command.withDescription("show page metadata"))

const update = Command.make(
  "update",
  {
    title: Flag.optional(Flag.string("title").pipe(Flag.withDescription("new title"))),
    slug: Flag.optional(Flag.string("slug").pipe(Flag.withDescription("new slug"))),
    raw: Flag.optional(
      Flag.boolean("raw").pipe(
        Flag.withDescription("serve as a complete HTML document (no house theme)")
      )
    ),
    ttl: Flag.optional(
      Flag.integer("ttl").pipe(Flag.withDescription("auto-delete after N days (0 = never)"))
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print the raw JSON response")),
    server: serverFlag,
    id: Argument.string("id"),
    file: Argument.optional(Argument.string("file").pipe(Argument.withDescription("HTML file, or - for stdin")))
  },
  (config) =>
    Effect.gen(function* () {
      const request: Record<string, unknown> = {}
      if (Option.isSome(config.file)) request["html"] = yield* readInput(config.file.value)
      if (Option.isSome(config.title)) request["title"] = config.title.value
      if (Option.isSome(config.slug)) request["slug"] = config.slug.value
      if (Option.isSome(config.raw)) request["raw"] = config.raw.value
      if (Option.isSome(config.ttl)) request["ttl_days"] = config.ttl.value
      if (Object.keys(request).length === 0) {
        return yield* cliError("nothing to update: pass a <file> and/or --title/--slug/--raw/--ttl")
      }
      const client = yield* makeClient(serverValue(config.server))
      const response = yield* client.request("PUT", `/api/pages/${config.id}`, request)
      const page = yield* decodePage(response)
      yield* report(page, config.json, "Updated")
    })
).pipe(Command.withDescription("replace a page"))

const del = Command.make(
  "delete",
  { server: serverFlag, id: Argument.string("id") },
  (config) =>
    Effect.gen(function* () {
      const client = yield* makeClient(serverValue(config.server))
      yield* client.request("DELETE", `/api/pages/${config.id}`)
      yield* Console.log(`✓ Deleted ${config.id}`)
    })
).pipe(Command.withDescription("delete a page"), Command.withAlias("rm"))

const version = Command.make("version", {}, () => Console.log(`cpages ${VERSION}`)).pipe(
  Command.withDescription("print version")
)

// --- entrypoint ---------------------------------------------------------------

const root = Command.make("cpages").pipe(
  Command.withDescription("publish HTML pages to Columbia Pages"),
  Command.withSubcommands([login, logout, status, create, list, get, update, del, version])
)

const AppLive = Layer.mergeAll(FetchHttpClient.layer, CliConfigLive).pipe(
  Layer.provideMerge(BunServices.layer)
)

root.pipe(
  Command.run({ version: VERSION }),
  Effect.catchTag("CliUserError", (error) =>
    Console.error(`error: ${error.message}`).pipe(Effect.andThen(Effect.fail(new SilentExit())))
  ),
  Effect.provide(AppLive),
  BunRuntime.runMain
)
