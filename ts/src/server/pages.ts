import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { newID } from "../internal/crypto.ts"
import type { Page } from "../store/models.ts"
import { Store } from "../store/Store.ts"
import type { Credential } from "./auth.ts"
import { CurrentTime, ServerConfig } from "./Config.ts"
import { BadRequest, decodeBody } from "./decode.ts"
import { errJson, json } from "./util.ts"

const ttlToExpiry = (now: Date, days: number): Date | null =>
  days <= 0 ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8")

interface RespInput {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly raw: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date | null
  readonly size: number
}

const toResp = (baseURL: string, p: RespInput): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: p.id,
    url: baseURL + "/p/" + p.id,
    title: p.title,
    raw: p.raw,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  }
  if (p.slug !== "") out.slug = p.slug
  if (p.expiresAt !== null) out.expires_at = p.expiresAt.toISOString()
  if (p.size > 0) out.size = p.size
  return out
}

const asString = (v: unknown, field: string): Effect.Effect<string, BadRequest> =>
  typeof v === "string" ? Effect.succeed(v) : Effect.fail(new BadRequest({ message: `invalid JSON: ${field} must be a string` }))
const asBool = (v: unknown, field: string): Effect.Effect<boolean, BadRequest> =>
  typeof v === "boolean" ? Effect.succeed(v) : Effect.fail(new BadRequest({ message: `invalid JSON: ${field} must be a boolean` }))
const asInt = (v: unknown, field: string): Effect.Effect<number, BadRequest> =>
  typeof v === "number" && Number.isInteger(v)
    ? Effect.succeed(v)
    : Effect.fail(new BadRequest({ message: `invalid JSON: ${field} must be an integer` }))

const handleCreate = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const clock = yield* CurrentTime
  const body = yield* decodeBody(["title", "slug", "html", "raw", "ttl_days"])

  const title = (yield* asString(body.title ?? "", "title")).trim()
  if (title === "") return errJson(400, "title is required")
  const html = yield* asString(body.html ?? "", "html")
  if (html.trim() === "") return errJson(400, "html is required")
  const slug = (body.slug === undefined ? "" : yield* asString(body.slug, "slug")).trim()
  const raw = body.raw === undefined ? false : yield* asBool(body.raw, "raw")
  const ttlDays = body.ttl_days === undefined ? 0 : yield* asInt(body.ttl_days, "ttl_days")

  const now = clock.now()
  const base: Omit<Page, "id"> = {
    title,
    slug,
    html,
    raw,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlToExpiry(now, ttlDays),
  }

  // Generate a unique id (collisions are astronomically unlikely; retry anyway).
  const attempt = (n: number): Effect.Effect<string, never, Store> =>
    n >= 5
      ? Effect.succeed("")
      : Effect.gen(function* () {
          const id = newID()
          const result = yield* store.create({ ...base, id }).pipe(Effect.either)
          return result._tag === "Right" ? id : yield* attempt(n + 1)
        })
  const id = yield* attempt(0)
  if (id === "") return errJson(500, "could not save page")

  return json(201, toResp(config.baseURL, { ...base, id, size: byteLen(html) }))
}).pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errJson(400, e.message))))

const handleList = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const req = yield* HttpServerRequest.HttpServerRequest
  let limit = 50
  const raw = new URL(req.url, "http://host").searchParams.get("limit")
  if (raw !== null && raw !== "") {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 0) limit = n
  }
  const metas = yield* store.list(limit).pipe(Effect.orElseSucceed(() => undefined))
  if (metas === undefined) return errJson(500, "could not list pages")
  return json(200, { pages: metas.map((m) => toResp(config.baseURL, m)) })
})

const handleGetMeta = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const params = yield* HttpRouter.params
  const id = params.id ?? ""
  return yield* store.get(id).pipe(
    Effect.map((p) => json(200, toResp(config.baseURL, { ...p, size: byteLen(p.html) }))),
    Effect.catchTag("NotFound", () => Effect.succeed(errJson(404, "page not found"))),
    Effect.orElseSucceed(() => errJson(500, "could not load page")),
  )
})

const handleUpdate = Effect.gen(function* () {
  const config = yield* ServerConfig
  const store = yield* Store
  const clock = yield* CurrentTime
  const params = yield* HttpRouter.params
  const id = params.id ?? ""
  const body = yield* decodeBody(["title", "slug", "html", "raw", "ttl_days"])

  const loaded = yield* store.get(id).pipe(
    Effect.map((p) => ({ ok: true as const, p })),
    Effect.catchTag("NotFound", () => Effect.succeed({ ok: false as const, status: 404, msg: "page not found" })),
    Effect.orElseSucceed(() => ({ ok: false as const, status: 500, msg: "could not load page" })),
  )
  if (!loaded.ok) return errJson(loaded.status, loaded.msg)

  let next: Page = loaded.p
  if (body.title !== undefined && body.title !== null) {
    const t = (yield* asString(body.title, "title")).trim()
    if (t === "") return errJson(400, "title cannot be empty")
    next = { ...next, title: t }
  }
  if (body.slug !== undefined && body.slug !== null) {
    next = { ...next, slug: (yield* asString(body.slug, "slug")).trim() }
  }
  if (body.html !== undefined && body.html !== null) {
    const h = yield* asString(body.html, "html")
    if (h.trim() === "") return errJson(400, "html cannot be empty")
    next = { ...next, html: h }
  }
  if (body.raw !== undefined && body.raw !== null) {
    next = { ...next, raw: yield* asBool(body.raw, "raw") }
  }
  const now = clock.now()
  if (body.ttl_days !== undefined && body.ttl_days !== null) {
    next = { ...next, expiresAt: ttlToExpiry(now, yield* asInt(body.ttl_days, "ttl_days")) }
  }
  next = { ...next, updatedAt: now }

  const saved = yield* store.save(next).pipe(Effect.either)
  if (saved._tag === "Left") return errJson(500, "could not save page")
  return json(200, toResp(config.baseURL, { ...next, size: byteLen(next.html) }))
}).pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errJson(400, e.message))))

const handleDelete = Effect.gen(function* () {
  const store = yield* Store
  const params = yield* HttpRouter.params
  const id = params.id ?? ""
  return yield* store.del(id).pipe(
    Effect.as(json(200, { id, deleted: true })),
    Effect.catchTag("NotFound", () => Effect.succeed(errJson(404, "page not found"))),
    Effect.orElseSucceed(() => errJson(500, "could not delete page")),
  )
})

const handleAuthCheck = (
  credential: Credential,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.succeed(
    json(200, {
      ok: true,
      credential_type: credential.kind,
      scopes: credential.scopes,
      label: credential.label,
      expires_at: credential.expiresAt === null ? null : credential.expiresAt.toISOString(),
    }),
  )

export const pageHandlers = {
  handleCreate,
  handleList,
  handleGetMeta,
  handleUpdate,
  handleDelete,
  handleAuthCheck,
}
