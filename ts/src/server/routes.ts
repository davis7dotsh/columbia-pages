import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerConfig } from "./Config.ts"
import type { ServerConfigShape } from "./Config.ts"
import { hostOf, logPath } from "./util.ts"
import { withAuth } from "./auth.ts"
import { pageHandlers } from "./pages.ts"
import { handleDeviceCode, handleDeviceToken, handleDiscovery, handleSelfRevoke } from "./device.ts"
import { handleHealth, handleIndex, handleServePage, handleThemeCSS } from "./public.ts"
import {
  controlHeaders,
  handleActivate,
  handleActivateDecision,
  handleAdminCSS,
  handleAdminLogin,
  handleAdminLoginPost,
  handleAdminLogout,
  handleAdminTokenRevoke,
  handleAdminTokens,
  requireAdmin,
} from "./admin.ts"

/** RoutesLive registers every route on the ambient HttpRouter as a layer. */
const RoutesLive = Layer.mergeAll(
  // Public.
  HttpRouter.add("GET", "/healthz", handleHealth),
  HttpRouter.add("GET", "/theme.css", handleThemeCSS),
  HttpRouter.add("GET", "/p/:id", handleServePage),
  HttpRouter.add("GET", "/", handleIndex),
  HttpRouter.add("GET", "/.well-known/columbia-pages", handleDiscovery),

  // Authenticated JSON API.
  HttpRouter.add("GET", "/api/auth", withAuth("pages:read", pageHandlers.handleAuthCheck)),
  HttpRouter.add("POST", "/api/pages", withAuth("pages:write", () => pageHandlers.handleCreate)),
  HttpRouter.add("GET", "/api/pages", withAuth("pages:read", () => pageHandlers.handleList)),
  HttpRouter.add("GET", "/api/pages/:id", withAuth("pages:read", () => pageHandlers.handleGetMeta)),
  HttpRouter.add("PUT", "/api/pages/:id", withAuth("pages:write", () => pageHandlers.handleUpdate)),
  HttpRouter.add("DELETE", "/api/pages/:id", withAuth("pages:write", () => pageHandlers.handleDelete)),

  // Device authorization.
  HttpRouter.add("POST", "/api/auth/device/code", handleDeviceCode),
  HttpRouter.add("POST", "/api/auth/device/token", handleDeviceToken),
  HttpRouter.add("POST", "/api/auth/revoke", withAuth("pages:read", handleSelfRevoke)),

  // Owner browser flows.
  HttpRouter.add("GET", "/activate", requireAdmin(handleActivate)),
  HttpRouter.add("POST", "/activate", requireAdmin(handleActivateDecision)),
  HttpRouter.add("GET", "/admin/login", handleAdminLogin),
  HttpRouter.add("POST", "/admin/login", handleAdminLoginPost),
  HttpRouter.add("POST", "/admin/logout", requireAdmin(handleAdminLogout)),
  HttpRouter.add("GET", "/admin/tokens", requireAdmin(handleAdminTokens)),
  HttpRouter.add("POST", "/admin/tokens/:id/revoke", requireAdmin(handleAdminTokenRevoke)),
  HttpRouter.add("GET", "/admin/style.css", handleAdminCSS),
)

const pathOf = (url: string): string => new URL(url, "http://placeholder.invalid").pathname

/** routeAllowed mirrors the Go host/path gate that separates the two origins. */
const routeAllowed = (path: string, host: string, config: ServerConfigShape): boolean => {
  if (path === "/healthz") return true
  const h = host.toLowerCase()
  if (h === config.publicHost.toLowerCase()) {
    return (
      path === "/" ||
      path === "/theme.css" ||
      path === "/.well-known/columbia-pages" ||
      path.startsWith("/p/")
    )
  }
  if (h === config.controlHost.toLowerCase()) {
    return (
      path === "/.well-known/columbia-pages" ||
      path.startsWith("/api/") ||
      path === "/activate" ||
      path.startsWith("/admin/")
    )
  }
  return false
}

const applyControlHeaders = (
  res: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse =>
  controlHeaders.reduce((acc, [name, value]) => HttpServerResponse.setHeader(acc, name, value), res)

/**
 * GateMiddleware wraps every request with host gating, control-origin headers,
 * and access logging. The static config is read once at construction; the
 * per-request handler only touches the request service.
 */
const GateMiddleware = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    return (inner) =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const start = Date.now()
        const path = pathOf(req.url)
        const host = hostOf(req)
        const log = (status: number) =>
          console.log(`${req.method} ${logPath(path)} -> ${status} (${Date.now() - start}ms)`)

        if (!routeAllowed(path, host, config)) {
          log(421)
          return HttpServerResponse.text("misdirected request\n", {
            status: 421,
            contentType: "text/plain; charset=utf-8",
          })
        }
        const isControl = host.toLowerCase() === config.controlHost.toLowerCase()
        const res = yield* (isControl ? Effect.map(inner, applyControlHeaders) : inner)
        log(res.status)
        return res
      })
  }),
  { global: true },
)

/** The full application layer: routes plus the host-gating global middleware. */
export const AppLive = Layer.mergeAll(RoutesLive, GateMiddleware)
