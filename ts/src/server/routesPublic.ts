import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { nowIso } from "../shared/time.ts"
import { ServerConfig } from "./config.ts"
import { notFoundText } from "./http.ts"
import { PagesStore } from "./pagesStore.ts"
import { renderThemed } from "./render.ts"
import { themeCss } from "./theme.ts"

const handleServePage = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  const id = params["id"] ?? ""
  const pages = yield* PagesStore
  const now = yield* nowIso
  return yield* pages.get(id).pipe(
    Effect.map((page) => {
      if (page.expiresAt !== null && page.expiresAt <= now) return notFoundText
      return HttpServerResponse.text(
        page.raw ? page.html : renderThemed(page.title, page.html),
        {
          contentType: "text/html; charset=utf-8",
          headers: {
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff"
          }
        }
      )
    }),
    Effect.catchTag("PageNotFound", () => Effect.succeed(notFoundText)),
    Effect.catchTag("SqlError", () =>
      Effect.succeed(
        HttpServerResponse.text("internal error\n", {
          status: 500,
          contentType: "text/plain; charset=utf-8"
        })
      )
    )
  )
})

const handleDiscovery = Effect.gen(function* () {
  const config = yield* ServerConfig
  return HttpServerResponse.jsonUnsafe(
    {
      control_url: config.controlUrl,
      content_url: config.publicUrl,
      device_authorization: true
    },
    { contentType: "application/json; charset=utf-8" }
  )
})

export const PublicRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/healthz",
      HttpServerResponse.text("ok", { contentType: "text/plain; charset=utf-8" })
    )
    yield* router.add(
      "GET",
      "/",
      HttpServerResponse.text("Columbia Pages\n", { contentType: "text/plain; charset=utf-8" })
    )
    yield* router.add(
      "GET",
      "/theme.css",
      HttpServerResponse.text(themeCss, {
        contentType: "text/css; charset=utf-8",
        headers: { "cache-control": "public, max-age=3600" }
      })
    )
    yield* router.add("GET", "/p/:id", handleServePage)
    yield* router.add("GET", "/.well-known/columbia-pages", handleDiscovery)
    // The Go server's mux answers 404 itself for unknown paths after host
    // gating; this wildcard makes every request pass through the same global
    // middleware so gating and logging behave identically.
    yield* router.add("*", "*", Effect.succeed(notFoundText))
  })
)
