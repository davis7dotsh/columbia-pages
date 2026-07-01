import * as fs from "node:fs"
import { Console, Effect, Option } from "effect"
import { Args, Command, Options } from "@effect/cli"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { normalizeServerURL } from "../internal/origin.ts"
import { authCheck, type ApiClient, CliError, type PageResp, request } from "./client.ts"
import { configPath, removeConfig, resolve } from "./config.ts"
import { loginWithDevice } from "./login.ts"

const version = "0.1.0"

const fail = (message: string) => new CliError({ message })

// --- helpers ---------------------------------------------------------------

const readInput = (path: string): Effect.Effect<string, CliError> =>
  Effect.try({
    try: () => fs.readFileSync(path === "-" ? 0 : path, "utf8"),
    catch: (e) => fail((e as Error).message),
  })

const newClient = (serverFlag: string): Effect.Effect<ApiClient, CliError> =>
  Effect.gen(function* () {
    const r = resolve(serverFlag)
    if (r.server === "") return yield* fail("no server configured \u2014 run `cpages login`")
    const base = yield* Effect.try({ try: () => normalizeServerURL(r.server), catch: (e) => fail((e as Error).message) })
    if (r.token === "") return yield* fail("not logged in \u2014 run `cpages login`")
    return { base, token: r.token }
  })

const humanSize = (n: number): string => {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)}MB`
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)}KB`
  return `${n}B`
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "\u2026")

const fmtLocal = (iso: string): string => {
  const d = new Date(iso)
  const p = (x: number) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const expiryStr = (iso: string | null | undefined): string => (iso == null ? "\u2014" : fmtLocal(iso))

const report = (p: PageResp, jsonOut: boolean, verb: string): Effect.Effect<void> => {
  if (jsonOut) return Console.log(JSON.stringify(p, null, 2))
  const lines: Array<string> = []
  lines.push(verb !== "" ? `\u2713 ${verb} "${p.title}"` : p.title)
  lines.push(p.url)
  let meta = "  id " + p.id
  if (p.raw) meta += " \u00b7 raw"
  if (p.size !== undefined && p.size > 0) meta += ` \u00b7 ${humanSize(p.size)}`
  if (p.expires_at != null) meta += " \u00b7 expires " + fmtLocal(p.expires_at)
  lines.push(meta)
  return Console.log(lines.join("\n"))
}

// --- shared options --------------------------------------------------------

const serverOpt = Options.text("server").pipe(
  Options.withDescription("server base URL (overrides saved login)"),
  Options.withDefault(""),
)
const jsonOpt = Options.boolean("json").pipe(Options.withDescription("print the raw JSON response"))

// --- commands --------------------------------------------------------------

const create = Command.make(
  "create",
  {
    server: serverOpt,
    title: Options.text("title").pipe(Options.withDescription("page title (required)"), Options.withDefault("")),
    slug: Options.text("slug").pipe(Options.withDescription("optional human label"), Options.withDefault("")),
    raw: Options.boolean("raw").pipe(Options.withDescription("serve as a complete HTML document (no house theme)")),
    ttl: Options.integer("ttl").pipe(Options.withDescription("auto-delete after N days (0 = never)"), Options.withDefault(0)),
    json: jsonOpt,
    file: Args.text({ name: "file" }),
  },
  ({ file, json, raw, server, slug, title, ttl }) =>
    Effect.gen(function* () {
      if (title.trim() === "") return yield* fail("--title is required")
      const body = yield* readInput(file)
      const client = yield* newClient(server)
      const resp = yield* request<PageResp>(client, "POST", "/api/pages", {
        title,
        slug,
        html: body,
        raw,
        ttl_days: ttl,
      })
      yield* report(resp!, json, "Published")
    }),
).pipe(Command.withDescription("publish a page"))

const update = Command.make(
  "update",
  {
    server: serverOpt,
    title: Options.optional(Options.text("title").pipe(Options.withDescription("new title"))),
    slug: Options.optional(Options.text("slug").pipe(Options.withDescription("new slug"))),
    raw: Options.optional(Options.boolean("raw").pipe(Options.withDescription("serve as a complete HTML document"))),
    ttl: Options.optional(Options.integer("ttl").pipe(Options.withDescription("auto-delete after N days (0 = never)"))),
    json: jsonOpt,
    id: Args.text({ name: "id" }),
    file: Args.optional(Args.text({ name: "file" })),
  },
  ({ file, id, json, raw, server, slug, title, ttl }) =>
    Effect.gen(function* () {
      const req: Record<string, unknown> = {}
      if (Option.isSome(file)) req.html = yield* readInput(file.value)
      if (Option.isSome(title)) req.title = title.value
      if (Option.isSome(slug)) req.slug = slug.value
      if (Option.isSome(raw)) req.raw = raw.value
      if (Option.isSome(ttl)) req.ttl_days = ttl.value
      if (Object.keys(req).length === 0) {
        return yield* fail("nothing to update: pass a <file> and/or --title/--slug/--raw/--ttl")
      }
      const client = yield* newClient(server)
      const resp = yield* request<PageResp>(client, "PUT", "/api/pages/" + id, req)
      yield* report(resp!, json, "Updated")
    }),
).pipe(Command.withDescription("replace a page"))

const list = Command.make(
  "list",
  {
    server: serverOpt,
    limit: Options.integer("limit").pipe(Options.withDescription("max pages to show (0 = all)"), Options.withDefault(50)),
    json: jsonOpt,
  },
  ({ json, limit, server }) =>
    Effect.gen(function* () {
      const client = yield* newClient(server)
      const out = yield* request<{ pages: ReadonlyArray<PageResp> }>(client, "GET", `/api/pages?limit=${limit}`)
      const pages = out?.pages ?? []
      if (json) return yield* Console.log(JSON.stringify(pages, null, 2))
      if (pages.length === 0) return yield* Console.log("No pages yet.")
      const rows = pages.map((p) =>
        [p.id, truncate(p.title, 32), fmtLocal(p.created_at), expiryStr(p.expires_at), p.url].join("  "),
      )
      yield* Console.log(["ID  TITLE  CREATED  EXPIRES  URL", ...rows].join("\n"))
    }),
).pipe(Command.withDescription("list pages"))

const get = Command.make(
  "get",
  { server: serverOpt, json: jsonOpt, id: Args.text({ name: "id" }) },
  ({ id, json, server }) =>
    Effect.gen(function* () {
      const client = yield* newClient(server)
      const resp = yield* request<PageResp>(client, "GET", "/api/pages/" + id)
      yield* report(resp!, json, "")
    }),
).pipe(Command.withDescription("show page metadata"))

const del = Command.make(
  "delete",
  { server: serverOpt, id: Args.text({ name: "id" }) },
  ({ id, server }) =>
    Effect.gen(function* () {
      const client = yield* newClient(server)
      yield* request(client, "DELETE", "/api/pages/" + id)
      yield* Console.log(`\u2713 Deleted ${id}`)
    }),
).pipe(Command.withDescription("delete a page"))

const login = Command.make(
  "login",
  {
    server: serverOpt,
    deviceName: Options.text("device-name").pipe(
      Options.withDescription("label shown to the owner during approval"),
      Options.withDefault(""),
    ),
    readOnly: Options.boolean("read-only").pipe(Options.withDescription("request only pages:read")),
  },
  ({ deviceName, readOnly, server }) => loginWithDevice(server, deviceName, readOnly),
).pipe(Command.withDescription("authenticate this device with the server"))

const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const r = resolve("")
    if (r.server !== "" && r.token !== "") {
      const base = yield* Effect.try({ try: () => normalizeServerURL(r.server), catch: (e) => fail((e as Error).message) }).pipe(
        Effect.either,
      )
      if (base._tag === "Right") {
        yield* request({ base: base.right, token: r.token }, "POST", "/api/auth/revoke", {}).pipe(Effect.ignore)
      }
    }
    const removed = yield* Effect.try({ try: () => removeConfig(), catch: (e) => fail((e as Error).message) })
    yield* Console.log(removed ? `\u2713 Logged out (removed ${configPath()})` : "Already logged out.")
  }),
).pipe(Command.withDescription("revoke device token and forget credentials"))

const status = Command.make("status", { server: serverOpt }, ({ server }) =>
  Effect.gen(function* () {
    const r = resolve(server)
    yield* Console.log(`Config file: ${configPath()}`)
    yield* Console.log(r.server === "" ? "Server:      (not set) \u2014 run `cpages login`" : `Server:      ${r.server} (from ${r.serverSrc})`)
    yield* Console.log(r.token === "" ? "Credential:  (not set) \u2014 run `cpages login`" : `Credential:  device token (from ${r.tokenSrc})`)
    if (r.server === "" || r.token === "") return yield* fail("authentication is not configured")
    const base = yield* Effect.try({ try: () => normalizeServerURL(r.server), catch: (e) => fail((e as Error).message) })

    const { body, status: code } = yield* authCheck({ base, token: r.token })
    if (code === 200 && body) {
      yield* Console.log("Auth:        \u2713 authenticated")
      const ct = body.credential_type.replaceAll("_", " ") || "device token"
      yield* Console.log(`Type:        ${ct}`)
      if (body.label !== "") yield* Console.log(`Label:       ${body.label}`)
      if (body.scopes.length > 0) yield* Console.log(`Scopes:      ${body.scopes.join(", ")}`)
      if (body.expires_at != null) yield* Console.log(`Expires:     ${new Date(body.expires_at).toISOString()}`)
      return
    }
    if (code === 401) {
      yield* Console.log("Auth:        \u2717 device token rejected, revoked, or expired")
      return yield* fail("device token authentication failed")
    }
    yield* Console.log(`Auth:        unexpected HTTP ${code}`)
    return yield* fail(`authentication check returned HTTP ${code}`)
  }),
).pipe(Command.withDescription("verify authentication and show token metadata"))

const cpages = Command.make("cpages", {}, () => Console.log("cpages \u2014 publish HTML pages. Run `cpages --help`.")).pipe(
  Command.withDescription("publish HTML pages to Columbia Pages"),
  Command.withSubcommands([login, logout, status, create, list, get, update, del]),
)

const run = Command.run(cpages, { name: "Columbia Pages CLI", version })

run(process.argv).pipe(
  Effect.catchIf(
    (e): e is CliError => e instanceof CliError,
    (e) => Console.error("error: " + e.message).pipe(Effect.zipRight(Effect.sync(() => process.exit(1)))),
  ),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
