import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
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

const router = HttpRouter.empty.pipe(
  // Public.
  HttpRouter.get("/healthz", handleHealth),
  HttpRouter.get("/theme.css", handleThemeCSS),
  HttpRouter.get("/p/:id", handleServePage),
  HttpRouter.get("/", handleIndex),
  HttpRouter.get("/.well-known/columbia-pages", handleDiscovery),

  // Authenticated JSON API.
  HttpRouter.get("/api/auth", withAuth("pages:read", pageHandlers.handleAuthCheck)),
  HttpRouter.post("/api/pages", withAuth("pages:write", () => pageHandlers.handleCreate)),
  HttpRouter.get("/api/pages", withAuth("pages:read", () => pageHandlers.handleList)),
  HttpRouter.get("/api/pages/:id", withAuth("pages:read", () => pageHandlers.handleGetMeta)),
  HttpRouter.put("/api/pages/:id", withAuth("pages:write", () => pageHandlers.handleUpdate)),
  HttpRouter.del("/api/pages/:id", withAuth("pages:write", () => pageHandlers.handleDelete)),
).pipe(
  // Device authorization.
  HttpRouter.post("/api/auth/device/code", handleDeviceCode),
  HttpRouter.post("/api/auth/device/token", handleDeviceToken),
  HttpRouter.post("/api/auth/revoke", withAuth("pages:read", handleSelfRevoke)),

  // Owner browser flows.
  HttpRouter.get("/activate", requireAdmin(handleActivate)),
  HttpRouter.post("/activate", requireAdmin(handleActivateDecision)),
  HttpRouter.get("/admin/login", handleAdminLogin),
  HttpRouter.post("/admin/login", handleAdminLoginPost),
  HttpRouter.post("/admin/logout", requireAdmin(handleAdminLogout)),
  HttpRouter.get("/admin/tokens", requireAdmin(handleAdminTokens)),
  HttpRouter.post("/admin/tokens/:id/revoke", requireAdmin(handleAdminTokenRevoke)),
  HttpRouter.get("/admin/style.css", handleAdminCSS),
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

/** The full application: host gating, control headers, and request logging. */
export const app = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const start = Date.now()
  const path = pathOf(req.url)
  const host = hostOf(req)

  const res = routeAllowed(path, host, config)
    ? yield* (host.toLowerCase() === config.controlHost.toLowerCase()
        ? router.pipe(Effect.map(applyControlHeaders))
        : router)
    : HttpServerResponse.text("misdirected request\n", { status: 421, contentType: "text/plain; charset=utf-8" })

  yield* Effect.sync(() =>
    console.log(`${req.method} ${logPath(path)} -> ${res.status} (${Date.now() - start}ms)`),
  )
  return res
})
