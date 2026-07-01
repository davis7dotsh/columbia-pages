import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SCOPE_READ, SCOPE_WRITE } from "../shared/api.ts"
import { newPageId } from "../shared/crypto.ts"
import { nowIso, ttlToExpiry } from "../shared/time.ts"
import { withAuth } from "./authn.ts"
import { jsonBody } from "./body.ts"
import { ServerConfig, type ServerConfigShape } from "./config.ts"
import { errResponse, jsonResponse } from "./http.ts"
import { PagesStore, type Page } from "./pagesStore.ts"

const CreateRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
  html: Schema.optionalKey(Schema.String),
  raw: Schema.optionalKey(Schema.Boolean),
  ttl_days: Schema.optionalKey(Schema.Number)
})

// null mirrors Go's pointer semantics: an explicit JSON null is "not set".
const UpdateRequest = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  html: Schema.optional(Schema.NullOr(Schema.String)),
  raw: Schema.optional(Schema.NullOr(Schema.Boolean)),
  ttl_days: Schema.optional(Schema.NullOr(Schema.Number))
})

const toResp = (config: ServerConfigShape, page: Page, size: number) => ({
  id: page.id,
  url: `${config.publicUrl}/p/${page.id}`,
  title: page.title,
  ...(page.slug !== "" ? { slug: page.slug } : {}),
  raw: page.raw,
  created_at: page.createdAt,
  updated_at: page.updatedAt,
  ...(page.expiresAt !== null ? { expires_at: page.expiresAt } : {}),
  ...(size > 0 ? { size } : {})
})

const handleCreate = withAuth(SCOPE_WRITE, () =>
  Effect.gen(function* () {
    const request = yield* jsonBody(CreateRequest)
    const title = (request.title ?? "").trim()
    if (title === "") return errResponse(400, "title is required")
    const html = request.html ?? ""
    if (html.trim() === "") return errResponse(400, "html is required")

    const config = yield* ServerConfig
    const pages = yield* PagesStore
    const now = yield* nowIso
    const draft = {
      title,
      slug: (request.slug ?? "").trim(),
      html,
      raw: request.raw ?? false,
      createdAt: now,
      updatedAt: now,
      expiresAt: ttlToExpiry(now, request.ttl_days ?? 0)
    }

    // Collisions are astronomically unlikely; retry with a fresh id anyway.
    let created: Page | null = null
    for (let attempt = 0; attempt < 5 && created === null; attempt++) {
      const candidate: Page = { id: yield* newPageId, ...draft }
      const inserted = yield* pages.create(candidate).pipe(
        Effect.as(true),
        Effect.catchTag("SqlError", () => Effect.succeed(false))
      )
      if (inserted) created = candidate
    }
    if (created === null) return errResponse(500, "could not save page")
    return jsonResponse(201, toResp(config, created, Buffer.byteLength(created.html)))
  })
)

const handleList = withAuth(SCOPE_READ, () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const config = yield* ServerConfig
    const pages = yield* PagesStore
    let limit = 50
    const limitParam = new URL(request.url, "http://localhost").searchParams.get("limit")
    if (limitParam !== null && /^\d+$/.test(limitParam)) limit = Number(limitParam)
    return yield* pages.list(limit).pipe(
      Effect.map((metas) =>
        jsonResponse(200, {
          pages: metas.map((meta) =>
            toResp(
              config,
              { ...meta, html: "" },
              meta.size
            )
          )
        })
      ),
      Effect.catchTag("SqlError", () => Effect.succeed(errResponse(500, "could not list pages")))
    )
  })
)

const handleGetMeta = withAuth(SCOPE_READ, () =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const config = yield* ServerConfig
    const pages = yield* PagesStore
    return yield* pages.get(params["id"] ?? "").pipe(
      Effect.map((page) => jsonResponse(200, toResp(config, page, Buffer.byteLength(page.html)))),
      Effect.catchTag("PageNotFound", () => Effect.succeed(errResponse(404, "page not found"))),
      Effect.catchTag("SqlError", () => Effect.succeed(errResponse(500, "could not load page")))
    )
  })
)

const handleUpdate = withAuth(SCOPE_WRITE, () =>
  Effect.gen(function* () {
    const request = yield* jsonBody(UpdateRequest)
    const params = yield* HttpRouter.params
    const config = yield* ServerConfig
    const pages = yield* PagesStore

    const existing = yield* pages.get(params["id"] ?? "").pipe(
      Effect.map((page) => ({ kind: "ok" as const, page })),
      Effect.catchTags({
        PageNotFound: () => Effect.succeed({ kind: "missing" as const }),
        SqlError: () => Effect.succeed({ kind: "error" as const })
      })
    )
    if (existing.kind === "missing") return errResponse(404, "page not found")
    if (existing.kind === "error") return errResponse(500, "could not load page")

    let page = existing.page
    if (request.title !== undefined && request.title !== null) {
      const title = request.title.trim()
      if (title === "") return errResponse(400, "title cannot be empty")
      page = { ...page, title }
    }
    if (request.slug !== undefined && request.slug !== null) {
      page = { ...page, slug: request.slug.trim() }
    }
    if (request.html !== undefined && request.html !== null) {
      if (request.html.trim() === "") return errResponse(400, "html cannot be empty")
      page = { ...page, html: request.html }
    }
    if (request.raw !== undefined && request.raw !== null) {
      page = { ...page, raw: request.raw }
    }
    const now = yield* nowIso
    if (request.ttl_days !== undefined && request.ttl_days !== null) {
      page = { ...page, expiresAt: ttlToExpiry(now, request.ttl_days) }
    }
    page = { ...page, updatedAt: now }

    const saved = yield* pages.save(page).pipe(
      Effect.as(true),
      Effect.catchTags({
        PageNotFound: () => Effect.succeed(false),
        SqlError: () => Effect.succeed(false)
      })
    )
    if (!saved) return errResponse(500, "could not save page")
    return jsonResponse(200, toResp(config, page, Buffer.byteLength(page.html)))
  })
)

const handleDelete = withAuth(SCOPE_WRITE, () =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const pages = yield* PagesStore
    const id = params["id"] ?? ""
    return yield* pages.remove(id).pipe(
      Effect.as(jsonResponse(200, { id, deleted: true })),
      Effect.catchTag("PageNotFound", () => Effect.succeed(errResponse(404, "page not found"))),
      Effect.catchTag("SqlError", () => Effect.succeed(errResponse(500, "could not delete page")))
    )
  })
)

// handleAuthCheck returns token metadata after withAuth verifies the request.
const handleAuthCheck = withAuth(SCOPE_READ, (credential) =>
  Effect.succeed(
    jsonResponse(200, {
      ok: true,
      credential_type: credential.kind,
      scopes: credential.scopes,
      label: credential.label,
      expires_at: credential.expiresAt
    })
  )
)

export const ApiRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/api/auth", handleAuthCheck)
    yield* router.add(
      "POST",
      "/api/pages",
      handleCreate.pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errResponse(400, e.message))))
    )
    yield* router.add("GET", "/api/pages", handleList)
    yield* router.add("GET", "/api/pages/:id", handleGetMeta)
    yield* router.add(
      "PUT",
      "/api/pages/:id",
      handleUpdate.pipe(Effect.catchTag("BadRequest", (e) => Effect.succeed(errResponse(400, e.message))))
    )
    yield* router.add("DELETE", "/api/pages/:id", handleDelete)
  })
)
