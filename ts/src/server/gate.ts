import { Clock, Console, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerConfig, type ServerConfigShape } from "./config.ts"
import { requestPath } from "./http.ts"

// Host gating is a security boundary, not a deployment convenience: the
// content origin serves published (active) HTML, so control-plane routes must
// never answer on it, and vice versa.
export const routeAllowed = (config: ServerConfigShape, host: string, path: string): boolean => {
  if (path === "/healthz") return true
  if (host === config.publicHost) {
    return (
      path === "/" ||
      path === "/theme.css" ||
      path === "/.well-known/columbia-pages" ||
      path.startsWith("/p/")
    )
  }
  if (host === config.controlHost) {
    return (
      path === "/.well-known/columbia-pages" ||
      path.startsWith("/api/") ||
      path === "/activate" ||
      path.startsWith("/admin/")
    )
  }
  return false
}

// Page ids are capability URLs; keep them out of the logs.
export const logPath = (path: string): string => {
  if (path.startsWith("/p/")) return "/p/[redacted]"
  if (path.startsWith("/api/pages/")) return "/api/pages/[redacted]"
  return path
}

const CONTROL_HEADERS = {
  "cache-control": "no-store",
  // Chrome serializes same-origin form submissions with Origin: null under
  // no-referrer, which makes exact-origin CSRF enforcement reject valid forms.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
} as const

export const GateLive = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const request = yield* HttpServerRequest.HttpServerRequest
      const start = yield* Clock.currentTimeMillis
      const host = (request.headers["host"] ?? "").toLowerCase()
      const path = requestPath(request)

      let response = routeAllowed(config, host, path)
        ? yield* httpEffect
        : HttpServerResponse.text("misdirected request\n", {
            status: 421,
            contentType: "text/plain; charset=utf-8"
          })
      if (host === config.controlHost) {
        response = HttpServerResponse.setHeaders(response, CONTROL_HEADERS)
      }
      const elapsed = (yield* Clock.currentTimeMillis) - start
      yield* Console.log(`${request.method} ${logPath(path)} -> ${response.status} (${elapsed}ms)`)
      return response
    }),
  { global: true }
)
