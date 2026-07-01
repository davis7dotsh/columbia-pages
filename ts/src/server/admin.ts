import { Duration, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import {
  constantTimeEqual,
  constantTimeSecretEqual,
  csrfToken,
  hashLowEntropy,
  normalizeUserCode,
  randomBase64,
} from "../internal/crypto.ts"
import type { APIToken, DeviceAuthorization } from "../store/models.ts"
import { NotFound } from "../store/models.ts"
import { Store } from "../store/Store.ts"
import { CurrentTime, Limiter, ServerConfig } from "./Config.ts"
import { escapeHTML as esc } from "../theme/render.ts"
import { requestSource } from "./util.ts"

const preAuthSessionLifetimeMs = 15 * 60 * 1000
const adminSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000

const adminCSS = `:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;background:#f5f6f7;color:#17191c}main{max-width:42rem;margin:3rem auto;padding:0 1rem}header{display:flex;justify-content:space-between;margin-bottom:2rem}section{background:#fff;border:1px solid #dfe2e5;border-radius:6px;padding:1.5rem;margin-bottom:1rem}label{display:block;font-weight:600;margin:.75rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.65rem;border:1px solid #a9afb5;border-radius:4px}button{padding:.65rem 1rem;border:0;border-radius:4px;background:#1769aa;color:#fff;font-weight:600;cursor:pointer}.danger{background:#a62b2b}.actions{display:flex;gap:.75rem;margin-top:1rem}.muted{color:#687078;font-size:.9rem}code{font-family:ui-monospace,monospace}@media(prefers-color-scheme:dark){body{background:#111315;color:#e8eaed}section{background:#191c1f;border-color:#34393e}input{background:#111315;color:#fff;border-color:#596169}a{color:#77bdf2}.muted{color:#aab0b6}}`

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Mirrors Go's "Jan 2, 2006 at 3:04 PM UTC" layout, always in UTC. */
const fmtLong = (d: Date): string => {
  let h = d.getUTCHours()
  const ampm = h >= 12 ? "PM" : "AM"
  h = h % 12
  if (h === 0) h = 12
  const min = String(d.getUTCMinutes()).padStart(2, "0")
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${h}:${min} ${ampm} UTC`
}

/** Mirrors Go's "Jan 2, 2006" layout, in UTC. */
const fmtShort = (d: Date): string =>
  `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`

const cookieName = (secure: boolean): string => (secure ? "__Host-cpages_admin" : "cpages_admin")

/** sanitizeNext rejects off-site or malformed redirect targets. */
const sanitizeNext = (value: string): string => {
  if (value === "" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/activate"
  }
  try {
    const u = new URL(value, "http://placeholder.invalid")
    return u.pathname + u.search
  } catch {
    return "/activate"
  }
}

const adminDoc = (title: string, content: string): string =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)} - Columbia Pages</title><link rel="stylesheet" href="/admin/style.css"></head>\n<body><main><header><a href="/admin/tokens">Columbia Pages</a><span>Control</span></header>${content}</main></body></html>`

const htmlResp = (
  status: number,
  title: string,
  content: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(adminDoc(title, content), {
    status,
    contentType: "text/html; charset=utf-8",
  })

const textResp = (status: number, msg: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(msg + "\n", { status, contentType: "text/plain; charset=utf-8" })

// --- session helpers -------------------------------------------------------

const currentSession = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const clock = yield* CurrentTime
  const raw = req.cookies[cookieName(config.secureCookie)] ?? ""
  if (raw === "") return yield* new NotFound()
  const session = yield* store.adminSessionByHash(hashLowEntropy(config.adminPasscode, raw), clock.now())
  return { session, raw } as const
})

const withAdminCookie = (
  secure: boolean,
  res: HttpServerResponse.HttpServerResponse,
  raw: string,
  lifetimeMs: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeSetCookie(res, cookieName(secure), raw, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge: Duration.millis(lifetimeMs),
  })

const withClearedAdminCookie = (
  secure: boolean,
  res: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.unsafeSetCookie(res, cookieName(secure), "", {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge: Duration.zero,
    expires: new Date(0),
  })

const validOrigin = (req: HttpServerRequest.HttpServerRequest, controlURL: string): boolean =>
  (req.headers["origin"] ?? "") === controlURL

const validCSRF = (passcode: string, raw: string, supplied: string): boolean =>
  constantTimeEqual(csrfToken(passcode, raw), supplied)

/** readForm parses a urlencoded body, falling back to query params (like Go's FormValue). */
const readForm = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const text = yield* req.text.pipe(Effect.orElseSucceed(() => null))
  if (text === null) return null
  const params = new URLSearchParams(text)
  const query = new URL(req.url, "http://placeholder.invalid").searchParams
  query.forEach((v, k) => {
    if (!params.has(k)) params.append(k, v)
  })
  return params
})

const formValue = (params: URLSearchParams, key: string): string => params.get(key) ?? ""

/**
 * requireAdmin runs `next` only for an authenticated owner session; otherwise it
 * redirects to the login page carrying the original destination.
 */
export const requireAdmin = <R>(
  next: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  R | HttpServerRequest.HttpServerRequest | ServerConfig | Store | CurrentTime
> =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const found = yield* currentSession.pipe(Effect.either)
    if (found._tag === "Right" && found.right.session.authenticated) {
      return yield* next
    }
    return HttpServerResponse.redirect("/admin/login?next=" + encodeURIComponent(sanitizeNext(req.url)), {
      status: 303,
    })
  })

// --- content templates -----------------------------------------------------

const loginContent = (error: string, csrf: string, next: string): string =>
  `<section><h1>Owner sign in</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}<form method="post" action="/admin/login"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="next" value="${esc(next)}"><label for="passcode">Admin passcode</label><input id="passcode" name="passcode" type="password" required autofocus autocomplete="current-password"><div class="actions"><button type="submit">Sign in</button></div></form></section>`

const activateContent = (
  error: string,
  csrf: string,
  code: string,
  grant: DeviceAuthorization | null,
): string => {
  const body = grant
    ? `<p><strong>${esc(grant.deviceLabel)}</strong></p><p class="muted">Scopes: <code>${esc(grant.scopes)}</code><br>Requested ${esc(fmtLong(grant.createdAt))}<br>Source: ${esc(grant.sourceHint)}</p><form method="post" action="/activate"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(code)}"><div class="actions"><button name="decision" value="approved" type="submit">Approve</button><button class="danger" name="decision" value="denied" type="submit">Deny</button></div></form>`
    : `<form method="get" action="/activate"><label for="code">Device code</label><input id="code" name="code" value="${esc(code)}" placeholder="ABCD-EFGH" required autofocus><div class="actions"><button type="submit">Continue</button></div></form>`
  return `<section><h1>Activate a device</h1>${error ? `<p>${esc(error)}</p>` : ""}${body}</section>`
}

const tokensContent = (tokens: ReadonlyArray<APIToken>, csrf: string): string => {
  const items =
    tokens.length === 0
      ? `<p>No device tokens have been issued.</p>`
      : tokens
          .map(
            (t) =>
              `<article><p><strong>${esc(t.deviceLabel)}</strong> <code>${esc(t.displayPrefix)}</code></p><p class="muted">${esc(t.scopes)}<br>Expires ${esc(fmtShort(t.expiresAt))}${t.revokedAt ? " - revoked" : ""}</p>${t.revokedAt ? "" : `<form method="post" action="/admin/tokens/${esc(t.id)}/revoke"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="danger" type="submit">Revoke</button></form>`}</article>`,
          )
          .join("")
  return `<section><h1>Device tokens</h1>${items}</section><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Sign out</button></form>`
}

// --- handlers --------------------------------------------------------------

export const handleAdminCSS = Effect.succeed(
  HttpServerResponse.setHeader(
    HttpServerResponse.text(adminCSS, { contentType: "text/css; charset=utf-8" }),
    "Cache-Control",
    "no-store",
  ),
)

export const handleAdminLogin = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const limiter = yield* Limiter
  const clock = yield* CurrentTime

  const next = sanitizeNext(new URL(req.url, "http://placeholder.invalid").searchParams.get("next") ?? "")

  const existing = yield* currentSession.pipe(Effect.either)
  if (existing._tag === "Left") {
    const [sourceKey] = requestSource(req, config)
    if (!limiter.allow("session:" + sourceKey, 10, preAuthSessionLifetimeMs, clock.now())) {
      return textResp(429, "too many session requests")
    }
  }

  // ensureAdminSession: reuse an existing session or create a fresh pre-auth one.
  if (existing._tag === "Right") {
    const csrf = csrfToken(config.adminPasscode, existing.right.raw)
    return htmlResp(200, "Sign in", loginContent("", csrf, next))
  }
  const raw = randomBase64(32)
  const id = randomBase64(12)
  const now = clock.now()
  const created = yield* store
    .createAdminSession({
      id,
      sessionHash: hashLowEntropy(config.adminPasscode, raw),
      authenticated: false,
      createdAt: now,
      expiresAt: new Date(now.getTime() + preAuthSessionLifetimeMs),
    })
    .pipe(
      Effect.as({ ok: true as const }),
      Effect.catchTag("SessionLimit", () => Effect.succeed({ ok: false as const, status: 429, msg: "too many active sessions" })),
      Effect.orElseSucceed(() => ({ ok: false as const, status: 500, msg: "could not start session" })),
    )
  if (!created.ok) return textResp(created.status, created.msg)

  const csrf = csrfToken(config.adminPasscode, raw)
  const res = htmlResp(200, "Sign in", loginContent("", csrf, next))
  return withAdminCookie(config.secureCookie, res, raw, preAuthSessionLifetimeMs)
})

export const handleAdminLoginPost = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const limiter = yield* Limiter
  const clock = yield* CurrentTime

  const form = yield* readForm
  if (form === null) return textResp(400, "invalid form")
  if (!validOrigin(req, config.controlURL)) return textResp(403, "invalid origin")

  const found = yield* currentSession.pipe(Effect.either)
  if (found._tag === "Left" || !validCSRF(config.adminPasscode, found.right.raw, formValue(form, "csrf"))) {
    return textResp(403, "invalid session")
  }
  const { session, raw } = found.right

  const [sourceKey] = requestSource(req, config)
  if (!limiter.allow("login:" + sourceKey, 5, 15 * 60 * 1000, clock.now())) {
    return textResp(429, "too many attempts")
  }

  if (!constantTimeSecretEqual(formValue(form, "passcode"), config.adminPasscode)) {
    const csrf = csrfToken(config.adminPasscode, raw)
    return htmlResp(
      401,
      "Sign in",
      loginContent("Incorrect admin passcode. Try again.", csrf, sanitizeNext(formValue(form, "next"))),
    )
  }

  const authed = yield* store
    .authenticateAdminSession(session.id, new Date(clock.now().getTime() + adminSessionLifetimeMs))
    .pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  if (!authed) return textResp(500, "could not authenticate session")

  const res = HttpServerResponse.redirect(sanitizeNext(formValue(form, "next")), { status: 303 })
  return withAdminCookie(config.secureCookie, res, raw, adminSessionLifetimeMs)
})

export const handleActivate = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const limiter = yield* Limiter
  const clock = yield* CurrentTime

  const raw = yield* currentSession.pipe(Effect.map((s) => s.raw), Effect.orElseSucceed(() => ""))
  const csrf = csrfToken(config.adminPasscode, raw)
  const code = (new URL(req.url, "http://placeholder.invalid").searchParams.get("code") ?? "").trim().toUpperCase()

  let error = ""
  let grant: DeviceAuthorization | null = null
  if (code !== "") {
    const [sourceKey] = requestSource(req, config)
    if (!limiter.allow("lookup:" + sourceKey, 20, 10 * 60 * 1000, clock.now())) {
      error = "Too many code lookups. Try again later."
    } else {
      const lookup = yield* store
        .deviceAuthorizationByUserCode(hashLowEntropy(config.adminPasscode, normalizeUserCode(code)), clock.now())
        .pipe(Effect.map((g) => ({ ok: true as const, g })), Effect.orElseSucceed(() => ({ ok: false as const })))
      if (!lookup.ok || lookup.g.status !== "pending") {
        error = "That code is invalid or expired."
      } else {
        grant = lookup.g
      }
    }
  }
  return htmlResp(200, "Activate device", activateContent(error, csrf, code, grant))
})

export const handleActivateDecision = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const store = yield* Store
  const clock = yield* CurrentTime

  const form = yield* readForm
  if (form === null) return textResp(400, "invalid form")
  if (!validOrigin(req, config.controlURL)) return textResp(403, "invalid origin")

  const found = yield* currentSession.pipe(Effect.either)
  if (found._tag === "Left" || !validCSRF(config.adminPasscode, found.right.raw, formValue(form, "csrf"))) {
    return textResp(403, "invalid csrf token")
  }
  const decision = formValue(form, "decision")
  if (decision !== "approved" && decision !== "denied") return textResp(400, "invalid decision")
  const code = formValue(form, "code").trim().toUpperCase()

  const ok = yield* store
    .decideDeviceAuthorization(hashLowEntropy(config.adminPasscode, normalizeUserCode(code)), decision, clock.now())
    .pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  if (!ok) return textResp(400, "code is invalid or expired")

  return htmlResp(200, "Device " + decision, `<section><h1>Device ${esc(decision)}</h1><p>You can return to the terminal.</p></section>`)
})

export const handleAdminTokens = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store

  const raw = yield* currentSession.pipe(Effect.map((s) => s.raw), Effect.orElseSucceed(() => ""))
  const listed = yield* store
    .listAPITokens()
    .pipe(Effect.map((tokens) => ({ ok: true as const, tokens })), Effect.orElseSucceed(() => ({ ok: false as const })))
  if (!listed.ok) return textResp(500, "could not list tokens")
  return htmlResp(200, "Device tokens", tokensContent(listed.tokens, csrfToken(config.adminPasscode, raw)))
})

/** validatedAdminSession requires a valid session, matching origin, and CSRF token. */
const validatedAdminSession = (form: URLSearchParams) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const config = yield* ServerConfig
    const found = yield* currentSession.pipe(Effect.either)
    if (
      found._tag === "Left" ||
      !validOrigin(req, config.controlURL) ||
      !validCSRF(config.adminPasscode, found.right.raw, formValue(form, "csrf"))
    ) {
      return { ok: false as const }
    }
    return { ok: true as const, session: found.right.session }
  })

export const handleAdminTokenRevoke = Effect.gen(function* () {
  const store = yield* Store
  const clock = yield* CurrentTime

  const form = yield* readForm
  if (form === null) return textResp(400, "invalid form")
  const validated = yield* validatedAdminSession(form)
  if (!validated.ok) return textResp(403, "invalid form")

  const routeParams = yield* HttpRouter.params
  const id = routeParams.id ?? ""

  const outcome = yield* store.revokeAPIToken(id, clock.now()).pipe(
    Effect.as({ ok: true as const }),
    Effect.catchTag("NotFound", () => Effect.succeed({ ok: true as const })),
    Effect.orElseSucceed(() => ({ ok: false as const })),
  )
  if (!outcome.ok) return textResp(500, "could not revoke token")
  return HttpServerResponse.redirect("/admin/tokens", { status: 303 })
})

export const handleAdminLogout = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store

  const form = yield* readForm
  if (form === null) return textResp(400, "invalid form")
  const validated = yield* validatedAdminSession(form)
  if (!validated.ok) return textResp(403, "invalid form")

  const ended = yield* store
    .deleteAdminSession(validated.session.id)
    .pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  if (!ended) return textResp(500, "could not end session")

  const res = HttpServerResponse.redirect("/admin/login", { status: 303 })
  return withClearedAdminCookie(config.secureCookie, res)
})

export const controlHeaders: ReadonlyArray<readonly [string, string]> = [
  ["Cache-Control", "no-store"],
  ["Referrer-Policy", "same-origin"],
  ["X-Content-Type-Options", "nosniff"],
  [
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  ],
]
