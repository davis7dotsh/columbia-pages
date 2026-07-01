import { Duration, Effect, Layer, Schedule } from "effect"
import { HttpServer } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as fs from "node:fs"
import * as path from "node:path"
import { Store } from "../store/Store.ts"
import { CurrentTime, Limiter, ServerConfig } from "./Config.ts"
import { app } from "./routes.ts"

const env = (key: string, def: string): string => {
  const v = process.env[key]
  return v !== undefined && v !== "" ? v : def
}

const dbPath = env("DB_PATH", "./columbia-pages.db")
const port = Number.parseInt(env("PORT", "8080"), 10)

const parseTTL = (): number => {
  const raw = (process.env["COLUMBIA_PAGES_TOKEN_TTL_DAYS"] ?? "").trim()
  if (raw === "") return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || String(n) !== raw) {
    throw new Error("COLUMBIA_PAGES_TOKEN_TTL_DAYS must be an integer")
  }
  return n
}

// Create the database directory up front (mirrors store.Open in Go).
const dir = path.dirname(dbPath)
if (dir !== "" && dir !== ".") fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

const ConfigLive = ServerConfig.layer({
  adminPasscode: process.env["COLUMBIA_PAGES_ADMIN_PASSCODE"] ?? "",
  publicBaseURL: process.env["PUBLIC_BASE_URL"] ?? "",
  controlBaseURL: process.env["CONTROL_BASE_URL"] ?? "",
  tokenTTLDays: parseTTL(),
  trustForwardedIP: (process.env["RAILWAY_ENVIRONMENT_ID"] ?? "") !== "",
})

const SqlLive = SqliteClient.layer({ filename: dbPath })
const StoreLive = Store.layer.pipe(Layer.provide(SqlLive))
const ServicesLive = Layer.mergeAll(ConfigLive, StoreLive, Limiter.layer, CurrentTime.layer)

// Periodically delete expired pages and authorization records.
const sweeper = Effect.gen(function* () {
  const store = yield* Store
  const clock = yield* CurrentTime
  // Read the clock inside the effect so each repetition sweeps against "now".
  const once = Effect.gen(function* () {
    const now = clock.now()
    yield* store.deleteExpired(now)
    yield* store.deleteExpiredAuth(now)
  }).pipe(Effect.ignore)
  yield* once
  yield* once.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))))
})

const SweeperLive = Layer.scopedDiscard(Effect.forkScoped(sweeper)).pipe(Layer.provide(ServicesLive))

const HttpLive = HttpServer.serve(app).pipe(
  HttpServer.withLogAddress,
  Layer.provide(ServicesLive),
  Layer.provide(BunHttpServer.layer({ port })),
)

BunRuntime.runMain(Layer.launch(Layer.merge(HttpLive, SweeperLive)))
