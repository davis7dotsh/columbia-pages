import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Store } from "../store/Store.ts"
import { CSS } from "../theme/theme.ts"
import { renderThemed } from "../theme/render.ts"
import { CurrentTime } from "./Config.ts"

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text("404 page not found\n", { status: 404, contentType: "text/plain; charset=utf-8" })

export const handleHealth = Effect.succeed(
  HttpServerResponse.text("ok", { contentType: "text/plain; charset=utf-8" }),
)

export const handleIndex = Effect.succeed(
  HttpServerResponse.text("Columbia Pages\n", { contentType: "text/plain; charset=utf-8" }),
)

export const handleThemeCSS = Effect.succeed(
  HttpServerResponse.setHeader(
    HttpServerResponse.text(CSS, { contentType: "text/css; charset=utf-8" }),
    "Cache-Control",
    "public, max-age=3600",
  ),
)

export const handleServePage = Effect.gen(function* () {
  const store = yield* Store
  const clock = yield* CurrentTime
  const params = yield* HttpRouter.params
  const id = params.id ?? ""

  const found = yield* store.get(id).pipe(
    Effect.map((page) => ({ tag: "ok" as const, page })),
    Effect.catchTag("NotFound", () => Effect.succeed({ tag: "notFound" as const })),
    Effect.orElseSucceed(() => ({ tag: "error" as const })),
  )
  if (found.tag === "notFound") return notFound()
  if (found.tag === "error") {
    return HttpServerResponse.text("internal error\n", { status: 500, contentType: "text/plain; charset=utf-8" })
  }
  const page = found.page
  if (page.expiresAt !== null && page.expiresAt.getTime() <= clock.now().getTime()) return notFound()

  const body = page.raw ? page.html : renderThemed(page.title, page.html)
  const res = HttpServerResponse.text(body, { contentType: "text/html; charset=utf-8" })
  return HttpServerResponse.setHeaders(res, {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })
})
