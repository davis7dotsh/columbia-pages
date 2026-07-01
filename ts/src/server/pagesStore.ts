import { Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

export class PageNotFound extends Data.TaggedError("PageNotFound")<{}> {}

// For themed pages, html holds body content the server wraps in the house
// theme; for raw pages, html is a complete document served verbatim.
export interface Page {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly html: string
  readonly raw: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly expiresAt: string | null
}

// Page metadata without the (potentially large) HTML body, for listings.
export interface PageMeta {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly raw: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly expiresAt: string | null
  readonly size: number
}

interface PageRow {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly html: string
  readonly raw: number
  readonly created_at: string
  readonly updated_at: string
  readonly expires_at: string | null
}

type MetaRow = Omit<PageRow, "html"> & { readonly size: number }

const rowToPage = (row: PageRow): Page => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  html: row.html,
  raw: row.raw !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at
})

const rowToMeta = (row: MetaRow): PageMeta => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  raw: row.raw !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  size: row.size
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const exists = (id: string) =>
    Effect.map(sql<{ id: string }>`SELECT id FROM pages WHERE id = ${id}`, (rows) => rows.length > 0)

  return {
    create: (page: Page) =>
      sql`INSERT INTO pages (id, title, slug, html, raw, created_at, updated_at, expires_at)
          VALUES (${page.id}, ${page.title}, ${page.slug}, ${page.html}, ${page.raw ? 1 : 0},
                  ${page.createdAt}, ${page.updatedAt}, ${page.expiresAt})`.pipe(Effect.asVoid),

    get: (id: string) =>
      Effect.flatMap(
        sql<PageRow>`SELECT id, title, slug, html, raw, created_at, updated_at, expires_at
                     FROM pages WHERE id = ${id}`,
        (rows) =>
          rows[0] === undefined
            ? Effect.fail(new PageNotFound())
            : Effect.succeed(rowToPage(rows[0]))
      ),

    save: (page: Page) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* exists(page.id))) return yield* new PageNotFound()
          yield* sql`UPDATE pages
                     SET title = ${page.title}, slug = ${page.slug}, html = ${page.html},
                         raw = ${page.raw ? 1 : 0}, updated_at = ${page.updatedAt},
                         expires_at = ${page.expiresAt}
                     WHERE id = ${page.id}`
        })
      ),

    remove: (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* exists(id))) return yield* new PageNotFound()
          yield* sql`DELETE FROM pages WHERE id = ${id}`
        })
      ),

    // Newest first; limit <= 0 means all.
    list: (limit: number) =>
      Effect.map(
        limit > 0
          ? sql<MetaRow>`SELECT id, title, slug, raw, created_at, updated_at, expires_at, length(html) AS size
                         FROM pages ORDER BY created_at DESC LIMIT ${limit}`
          : sql<MetaRow>`SELECT id, title, slug, raw, created_at, updated_at, expires_at, length(html) AS size
                         FROM pages ORDER BY created_at DESC`,
        (rows) => rows.map(rowToMeta)
      ),

    deleteExpired: (now: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const counted = yield* sql<{ n: number }>`SELECT count(*) AS n FROM pages
                                                    WHERE expires_at IS NOT NULL AND expires_at <= ${now}`
          yield* sql`DELETE FROM pages WHERE expires_at IS NOT NULL AND expires_at <= ${now}`
          return counted[0]?.n ?? 0
        })
      )
  } as const
})

export class PagesStore extends Context.Service<PagesStore>()("PagesStore", { make }) {}

export const PagesStoreLive = Layer.effect(PagesStore)(PagesStore.make)
