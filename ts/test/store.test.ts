import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PagesStore, type Page } from "../src/server/pagesStore.ts"
import { runWithStores } from "./stores.ts"

const page = (overrides: Partial<Page> = {}): Page => ({
  id: "abcdefghijkl",
  title: "Test Page",
  slug: "test",
  html: "<h1>Hello</h1>",
  raw: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  expiresAt: null,
  ...overrides
})

describe("PagesStore", () => {
  test("create and get roundtrip", async () => {
    const loaded = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(page())
        return yield* pages.get("abcdefghijkl")
      })
    )
    expect(loaded).toEqual(page())
  })

  test("get missing page fails with PageNotFound", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        return yield* pages.get("missing12345").pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("PageNotFound")
  })

  test("duplicate id fails", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(page())
        return yield* pages.create(page()).pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("SqlError")
  })

  test("save updates mutable fields and save of missing page fails", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(page())
        yield* pages.save(
          page({
            title: "Updated",
            html: "<p>new</p>",
            raw: true,
            updatedAt: "2026-07-02T00:00:00.000Z",
            expiresAt: "2026-08-01T00:00:00.000Z"
          })
        )
        const updated = yield* pages.get("abcdefghijkl")
        const missing = yield* pages
          .save(page({ id: "nope12345678" }))
          .pipe(Effect.flip)
        return { updated, missing }
      })
    )
    expect(result.updated.title).toBe("Updated")
    expect(result.updated.raw).toBe(true)
    expect(result.updated.expiresAt).toBe("2026-08-01T00:00:00.000Z")
    expect(result.updated.createdAt).toBe("2026-07-01T00:00:00.000Z")
    expect(result.missing._tag).toBe("PageNotFound")
  })

  test("list returns newest first with sizes and honors limit", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(
          page({ id: "aaaaaaaaaaaa", title: "old", createdAt: "2026-07-01T00:00:00.000Z" })
        )
        yield* pages.create(
          page({ id: "bbbbbbbbbbbb", title: "new", createdAt: "2026-07-02T00:00:00.000Z" })
        )
        const all = yield* pages.list(0)
        const limited = yield* pages.list(1)
        return { all, limited }
      })
    )
    expect(result.all.map((m) => m.title)).toEqual(["new", "old"])
    expect(result.all[0]?.size).toBe("<h1>Hello</h1>".length)
    expect(result.limited).toHaveLength(1)
    expect(result.limited[0]?.title).toBe("new")
  })

  test("remove deletes and second remove fails", async () => {
    const error = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(page())
        yield* pages.remove("abcdefghijkl")
        return yield* pages.remove("abcdefghijkl").pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("PageNotFound")
  })

  test("deleteExpired removes only pages expired at the cutoff", async () => {
    const result = await runWithStores(
      Effect.gen(function* () {
        const pages = yield* PagesStore
        yield* pages.create(page({ id: "keepforever1", expiresAt: null }))
        yield* pages.create(page({ id: "expiredpage1", expiresAt: "2026-07-01T00:00:00.000Z" }))
        yield* pages.create(page({ id: "notyetgone12", expiresAt: "2026-07-09T00:00:00.000Z" }))
        const removed = yield* pages.deleteExpired("2026-07-05T00:00:00.000Z")
        const remaining = yield* pages.list(0)
        return { removed, ids: remaining.map((m) => m.id).sort() }
      })
    )
    expect(result.removed).toBe(1)
    expect(result.ids).toEqual(["keepforever1", "notyetgone12"])
  })
})
