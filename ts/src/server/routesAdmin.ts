import { Data, Duration, Effect, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  constantTimeSecretEqual,
  constantTimeStringEqual,
  hashLowEntropy,
  normalizeUserCode,
  randomBase64
} from "../shared/crypto.ts"
import { addDaysIso, addSecondsIso, nowIso } from "../shared/time.ts"
import { AuthStore, type AdminSession, type ApiToken, type DeviceAuthorization } from "./authStore.ts"
import { formBody, type BadRequest } from "./body.ts"
import { ServerConfig, type ServerConfigShape } from "./config.ts"
import { requestPath, requestSource } from "./http.ts"
import { RateLimiter } from "./rateLimiter.ts"
import { escapeHtml } from "./render.ts"

const PRE_AUTH_SESSION_SECONDS = 15 * 60
const ADMIN_SESSION_SECONDS = 30 * 24 * 60 * 60

class NoSession extends Data.TaggedError("NoSession")<{}> {}

// --- HTML -------------------------------------------------------------------

const adminCss = `:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;background:#f5f6f7;color:#17191c}main{max-width:42rem;margin:3rem auto;padding:0 1rem}header{display:flex;justify-content:space-between;margin-bottom:2rem}section{background:#fff;border:1px solid #dfe2e5;border-radius:6px;padding:1.5rem;margin-bottom:1rem}label{display:block;font-weight:600;margin:.75rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.65rem;border:1px solid #a9afb5;border-radius:4px}button{padding:.65rem 1rem;border:0;border-radius:4px;background:#1769aa;color:#fff;font-weight:600;cursor:pointer}.danger{background:#a62b2b}.actions{display:flex;gap:.75rem;margin-top:1rem}.muted{color:#687078;font-size:.9rem}code{font-family:ui-monospace,monospace}@media(prefers-color-scheme:dark){body{background:#111315;color:#e8eaed}section{background:#191c1f;border-color:#34393e}input{background:#111315;color:#fff;border-color:#596169}a{color:#77bdf2}.muted{color:#aab0b6}}`

const layout = (title: string, content: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Columbia Pages</title><link rel="stylesheet" href="/admin/style.css"></head>
<body><main><header><a href="/admin/tokens">Columbia Pages</a><span>Control</span></header>${content}</main></body></html>`

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "Jan 2, 2006 at 3:04 PM UTC"
const formatGrantTime = (iso: string): string => {
  const d = new Date(iso)
  const hours24 = d.getUTCHours()
  const hours12 = ((hours24 + 11) % 12) + 1
  const meridiem = hours24 < 12 ? "AM" : "PM"
  const minutes = String(d.getUTCMinutes()).padStart(2, "0")
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hours12}:${minutes} ${meridiem} UTC`
}

// "Jan 2, 2006"
const formatDay = (iso: string): string => {
  const d = new Date(iso)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

const loginPage = (view: { next: string; csrf: string; error?: string }): string =>
  layout(
    "Sign in",
    `<section><h1>Owner sign in</h1>${
      view.error !== undefined ? `<p role="alert">${escapeHtml(view.error)}</p>` : ""
    }<form method="post" action="/admin/login"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="next" value="${escapeHtml(view.next)}"><label for="passcode">Admin passcode</label><input id="passcode" name="passcode" type="password" required autofocus autocomplete="current-password"><div class="actions"><button type="submit">Sign in</button></div></form></section>`
  )

const activatePage = (view: {
  code: string
  csrf: string
  error?: string
  grant?: DeviceAuthorization
}): string => {
  let body: string
  if (view.grant !== undefined) {
    const grant = view.grant
    body = `<p><strong>${escapeHtml(grant.deviceLabel)}</strong></p><p class="muted">Scopes: <code>${escapeHtml(grant.scopes)}</code><br>Requested ${escapeHtml(formatGrantTime(grant.createdAt))}<br>Source: ${escapeHtml(grant.sourceHint)}</p><form method="post" action="/activate"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><input type="hidden" name="code" value="${escapeHtml(view.code)}"><div class="actions"><button name="decision" value="approved" type="submit">Approve</button><button class="danger" name="decision" value="denied" type="submit">Deny</button></div></form>`
  } else {
    body = `<form method="get" action="/activate"><label for="code">Device code</label><input id="code" name="code" value="${escapeHtml(view.code)}" placeholder="ABCD-EFGH" required autofocus><div class="actions"><button type="submit">Continue</button></div></form>`
  }
  const messages = view.error !== undefined ? `<p>${escapeHtml(view.error)}</p>` : ""
  return layout("Activate device", `<section><h1>Activate a device</h1>${messages}${body}</section>`)
}

const decisionPage = (decision: string): string =>
  layout(
    `Device ${decision}`,
    `<section><h1>Device ${escapeHtml(decision)}</h1><p>You can return to the terminal.</p></section>`
  )

const tokensPage = (tokens: ReadonlyArray<ApiToken>, csrf: string): string => {
  const items =
    tokens.length === 0
      ? "<p>No device tokens have been issued.</p>"
      : tokens
          .map((token) => {
            const revoked = token.revokedAt !== null
            const revokeForm = revoked
              ? ""
              : `<form method="post" action="/admin/tokens/${encodeURIComponent(token.id)}/revoke"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="danger" type="submit">Revoke</button></form>`
            return `<article><p><strong>${escapeHtml(token.deviceLabel)}</strong> <code>${escapeHtml(token.displayPrefix)}</code></p><p class="muted">${escapeHtml(token.scopes)}<br>Expires ${escapeHtml(formatDay(token.expiresAt))}${revoked ? " - revoked" : ""}</p>${revokeForm}</article>`
          })
          .join("")
  return layout(
    "Device tokens",
    `<section><h1>Device tokens</h1>${items}</section><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Sign out</button></form>`
  )
}

const htmlResponse = (status: number, html: string) =>
  HttpServerResponse.text(html, { status, contentType: "text/html; charset=utf-8" })

const plainError = (status: number, message: string) =>
  HttpServerResponse.text(`${message}\n`, { status, contentType: "text/plain; charset=utf-8" })

// --- sessions ---------------------------------------------------------------

const passcode = (config: ServerConfigShape) => Redacted.value(config.adminPasscode)

const cookieName = (config: ServerConfigShape) =>
  config.secureCookie ? "__Host-cpages_admin" : "cpages_admin"

const setAdminCookie = (
  config: ServerConfigShape,
  response: HttpServerResponse.HttpServerResponse,
  raw: string,
  lifetimeSeconds: number
) =>
  HttpServerResponse.setCookieUnsafe(response, cookieName(config), raw, {
    path: "/",
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: "strict",
    maxAge: Duration.seconds(lifetimeSeconds)
  })

const clearAdminCookie = (
  config: ServerConfigShape,
  response: HttpServerResponse.HttpServerResponse
) =>
  HttpServerResponse.expireCookieUnsafe(response, cookieName(config), {
    path: "/",
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: "strict"
  })

const csrfToken = (config: ServerConfigShape, raw: string): string =>
  hashLowEntropy(passcode(config), `csrf:${raw}`)

const validCsrf = (config: ServerConfigShape, raw: string, supplied: string): boolean =>
  constantTimeStringEqual(csrfToken(config, raw), supplied)

const validOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  return (request.headers["origin"] ?? "") === config.controlUrl
})

interface SessionWithRaw {
  readonly session: AdminSession
  readonly raw: string
}

const adminSession: Effect.Effect<
  SessionWithRaw,
  NoSession,
  HttpServerRequest.HttpServerRequest | ServerConfig | AuthStore
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* AuthStore
  const raw = request.cookies[cookieName(config)] ?? ""
  if (raw === "") return yield* new NoSession()
  const now = yield* nowIso
  const session = yield* store
    .adminSessionByHash(hashLowEntropy(passcode(config), raw), now)
    .pipe(Effect.mapError(() => new NoSession()))
  return { session, raw }
})

const sanitizeNext = (value: string): string => {
  if (value === "" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/activate"
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return "/activate"
  try {
    const url = new URL(value, "http://placeholder")
    if (url.host !== "placeholder") return "/activate"
    return url.pathname + url.search
  } catch {
    return "/activate"
  }
}

const AdminForm = Schema.Struct({
  csrf: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(Schema.String),
  passcode: Schema.optionalKey(Schema.String),
  decision: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String)
})

// --- handlers ---------------------------------------------------------------

const queryParam = (request: HttpServerRequest.HttpServerRequest, name: string): string =>
  new URL(request.url, "http://localhost").searchParams.get(name) ?? ""

const handleAdminCss = HttpServerResponse.text(adminCss, {
  contentType: "text/css; charset=utf-8",
  headers: { "cache-control": "no-store" }
})

const handleAdminLogin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* AuthStore
  const limiter = yield* RateLimiter
  const next = sanitizeNext(queryParam(request, "next"))

  const existing = yield* adminSession.pipe(
    Effect.map((value): SessionWithRaw | null => value),
    Effect.catchTag("NoSession", () => Effect.succeed(null))
  )
  if (existing === null) {
    const { sourceKey } = yield* requestSource(config)
    if (!(yield* limiter.allow(`session:${sourceKey}`, 10, 15 * 60 * 1000))) {
      return plainError(429, "too many session requests")
    }
  }

  if (existing !== null) {
    return htmlResponse(200, loginPage({ next, csrf: csrfToken(config, existing.raw) }))
  }

  // Create a short-lived pre-auth session that carries the CSRF token.
  const raw = yield* randomBase64(32)
  const id = yield* randomBase64(12)
  const now = yield* nowIso
  const created = yield* store
    .createAdminSession({
      id,
      sessionHash: hashLowEntropy(passcode(config), raw),
      authenticated: false,
      createdAt: now,
      expiresAt: addSecondsIso(now, PRE_AUTH_SESSION_SECONDS)
    })
    .pipe(
      Effect.as<"ok" | "limit" | "error">("ok"),
      Effect.catchTag("SessionLimitReached", () => Effect.succeed("limit" as const)),
      Effect.catchTag("SqlError", () => Effect.succeed("error" as const))
    )
  if (created === "limit") return plainError(429, "too many active sessions")
  if (created === "error") return plainError(500, "could not start session")

  return setAdminCookie(
    config,
    htmlResponse(200, loginPage({ next, csrf: csrfToken(config, raw) })),
    raw,
    PRE_AUTH_SESSION_SECONDS
  )
})

const handleAdminLoginPost = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* AuthStore
  const limiter = yield* RateLimiter
  const form = yield* formBody(AdminForm)
  if (!(yield* validOrigin)) return plainError(403, "invalid origin")

  const existing = yield* adminSession.pipe(
    Effect.map((value): SessionWithRaw | null => value),
    Effect.catchTag("NoSession", () => Effect.succeed(null))
  )
  if (existing === null || !validCsrf(config, existing.raw, form.csrf ?? "")) {
    return plainError(403, "invalid session")
  }

  const { sourceKey } = yield* requestSource(config)
  if (!(yield* limiter.allow(`login:${sourceKey}`, 5, 15 * 60 * 1000))) {
    return plainError(429, "too many attempts")
  }

  if (!constantTimeSecretEqual(form.passcode ?? "", passcode(config))) {
    return htmlResponse(
      401,
      loginPage({
        next: sanitizeNext(form.next ?? ""),
        csrf: csrfToken(config, existing.raw),
        error: "Incorrect admin passcode. Try again."
      })
    )
  }

  const now = yield* nowIso
  const authenticated = yield* store
    .authenticateAdminSession(existing.session.id, addSecondsIso(now, ADMIN_SESSION_SECONDS))
    .pipe(Effect.as(true), Effect.catchTag("SqlError", () => Effect.succeed(false)))
  if (!authenticated) return plainError(500, "could not authenticate session")

  return setAdminCookie(
    config,
    HttpServerResponse.redirect(sanitizeNext(form.next ?? ""), { status: 303 }),
    existing.raw,
    ADMIN_SESSION_SECONDS
  )
})

const requireAdmin = <E, R>(
  handler: (session: SessionWithRaw) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const existing = yield* adminSession.pipe(
      Effect.map((value): SessionWithRaw | null => value),
      Effect.catchTag("NoSession", () => Effect.succeed(null))
    )
    if (existing === null || !existing.session.authenticated) {
      const nextPath = sanitizeNext(request.url)
      return HttpServerResponse.redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`, {
        status: 303
      })
    }
    return yield* handler(existing)
  })

// validatedAdminSession mirrors Go: authenticated session + origin + CSRF.
const validated = <E, R>(
  form: { readonly csrf?: string },
  session: SessionWithRaw,
  handler: () => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (!(yield* validOrigin) || !validCsrf(config, session.raw, form.csrf ?? "")) {
      return plainError(403, "invalid form")
    }
    return yield* handler()
  })

const handleActivate = requireAdmin((session) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const config = yield* ServerConfig
    const store = yield* AuthStore
    const limiter = yield* RateLimiter
    const code = queryParam(request, "code").trim().toUpperCase()
    const csrf = csrfToken(config, session.raw)

    if (code === "") return htmlResponse(200, activatePage({ code, csrf }))

    const { sourceKey } = yield* requestSource(config)
    if (!(yield* limiter.allow(`lookup:${sourceKey}`, 20, 10 * 60 * 1000))) {
      return htmlResponse(
        200,
        activatePage({ code, csrf, error: "Too many code lookups. Try again later." })
      )
    }
    const now = yield* nowIso
    const grant = yield* store
      .deviceAuthorizationByUserCode(hashLowEntropy(passcode(config), normalizeUserCode(code)), now)
      .pipe(
        Effect.map((value): DeviceAuthorization | null => value),
        Effect.catchTags({
          GrantNotFound: () => Effect.succeed(null),
          GrantExpired: () => Effect.succeed(null),
          SqlError: () => Effect.succeed(null)
        })
      )
    if (grant === null || grant.status !== "pending") {
      return htmlResponse(200, activatePage({ code, csrf, error: "That code is invalid or expired." }))
    }
    return htmlResponse(200, activatePage({ code, csrf, grant }))
  })
)

const handleActivateDecision = requireAdmin((session) =>
  Effect.gen(function* () {
    const store = yield* AuthStore
    const config = yield* ServerConfig
    const form = yield* formBody(AdminForm)
    if (!(yield* validOrigin)) return plainError(403, "invalid origin")
    if (!validCsrf(config, session.raw, form.csrf ?? "")) {
      return plainError(403, "invalid csrf token")
    }
    const decision = form.decision ?? ""
    if (decision !== "approved" && decision !== "denied") {
      return plainError(400, "invalid decision")
    }
    const code = (form.code ?? "").trim().toUpperCase()
    const now = yield* nowIso
    const decided = yield* store
      .decideDeviceAuthorization(hashLowEntropy(passcode(config), normalizeUserCode(code)), decision, now)
      .pipe(
        Effect.as(true),
        Effect.catchTags({
          GrantNotFound: () => Effect.succeed(false),
          SqlError: () => Effect.succeed(false)
        })
      )
    if (!decided) return plainError(400, "code is invalid or expired")
    return htmlResponse(200, decisionPage(decision))
  })
)

const handleAdminTokens = requireAdmin((session) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const store = yield* AuthStore
    return yield* store.listApiTokens.pipe(
      Effect.map((tokens) => htmlResponse(200, tokensPage(tokens, csrfToken(config, session.raw)))),
      Effect.catchTag("SqlError", () => Effect.succeed(plainError(500, "could not list tokens")))
    )
  })
)

const handleAdminTokenRevoke = requireAdmin((session) =>
  Effect.gen(function* () {
    const store = yield* AuthStore
    const params = yield* HttpRouter.params
    const form = yield* formBody(AdminForm)
    return yield* validated(form, session, () =>
      Effect.gen(function* () {
        const now = yield* nowIso
        const revoked = yield* store.revokeApiToken(params["id"] ?? "", now).pipe(
          Effect.as(true),
          Effect.catchTag("TokenNotFound", () => Effect.succeed(true)),
          Effect.catchTag("SqlError", () => Effect.succeed(false))
        )
        if (!revoked) return plainError(500, "could not revoke token")
        return HttpServerResponse.redirect("/admin/tokens", { status: 303 })
      })
    )
  })
)

const handleAdminLogout = requireAdmin((session) =>
  Effect.gen(function* () {
    const store = yield* AuthStore
    const config = yield* ServerConfig
    const form = yield* formBody(AdminForm)
    return yield* validated(form, session, () =>
      Effect.gen(function* () {
        const deleted = yield* store
          .deleteAdminSession(session.session.id)
          .pipe(Effect.as(true), Effect.catchTag("SqlError", () => Effect.succeed(false)))
        if (!deleted) return plainError(500, "could not end session")
        return clearAdminCookie(
          config,
          HttpServerResponse.redirect("/admin/login", { status: 303 })
        )
      })
    )
  })
)

const withFormErrors = <A extends HttpServerResponse.HttpServerResponse, R>(
  effect: Effect.Effect<A, BadRequest, R>
) => effect.pipe(Effect.catchTag("BadRequest", () => Effect.succeed(plainError(400, "invalid form"))))

export const AdminRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/activate", handleActivate)
    yield* router.add("POST", "/activate", withFormErrors(handleActivateDecision))
    yield* router.add("GET", "/admin/login", handleAdminLogin)
    yield* router.add("POST", "/admin/login", withFormErrors(handleAdminLoginPost))
    yield* router.add("POST", "/admin/logout", withFormErrors(handleAdminLogout))
    yield* router.add("GET", "/admin/tokens", handleAdminTokens)
    yield* router.add("POST", "/admin/tokens/:id/revoke", withFormErrors(handleAdminTokenRevoke))
    yield* router.add("GET", "/admin/style.css", handleAdminCss)
  })
)
