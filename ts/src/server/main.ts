// Command server runs the Columbia Pages HTTP service.
//
// Configuration (environment variables):
//
//	COLUMBIA_PAGES_ADMIN_PASSCODE  owner secret for browser approval
//	COLUMBIA_PAGES_TOKEN_TTL_DAYS  (default 90, range 1..365)
//	DB_PATH                        SQLite file path  (default ./columbia-pages.db)
//	PORT                           listen port       (default 8080)
//	PUBLIC_BASE_URL                content origin, e.g. https://pages.example.com
//	CONTROL_BASE_URL               control origin for API and browser authorization
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { AuthStoreLive } from "./authStore.ts"
import { ServerConfig, ServerConfigLive } from "./config.ts"
import { DatabaseLive } from "./db.ts"
import { GateLive } from "./gate.ts"
import { PagesStoreLive } from "./pagesStore.ts"
import { RateLimiterLive } from "./rateLimiter.ts"
import { AdminRoutes } from "./routesAdmin.ts"
import { ApiRoutes } from "./routesApi.ts"
import { DeviceAuthRoutes } from "./routesDeviceAuth.ts"
import { PublicRoutes } from "./routesPublic.ts"
import { SweeperLive } from "./sweeper.ts"

const AppRoutes = Layer.mergeAll(PublicRoutes, ApiRoutes, DeviceAuthRoutes, AdminRoutes, GateLive)

const ServerLive = BunHttpServer.layerConfig({
  port: Config.port("PORT").pipe(Config.withDefault(8080)),
  // Dual-stack like Go's ListenAndServe(":port"); *.localhost resolves to ::1.
  hostname: Config.string("HOST").pipe(Config.withDefault("::")),
  // Same cap as the Go server's MaxBytesReader on uploaded HTML.
  maxRequestBodySize: Config.succeed(8 * 1024 * 1024)
})

const ListenLogLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    yield* Console.log(`columbia-pages listening on :${config.port} (db=${config.dbPath})`)
  })
)

const StoresLive = Layer.mergeAll(PagesStoreLive, AuthStoreLive).pipe(
  Layer.provideMerge(DatabaseLive)
)

const CoreLive = Layer.mergeAll(StoresLive, RateLimiterLive).pipe(
  Layer.provideMerge(ServerConfigLive),
  Layer.provide(BunServices.layer)
)

const MainLive = Layer.mergeAll(
  HttpRouter.serve(AppRoutes, { disableLogger: true }).pipe(Layer.provide(ServerLive)),
  SweeperLive,
  ListenLogLive
).pipe(Layer.provide(CoreLive))

BunRuntime.runMain(Layer.launch(MainLive))
