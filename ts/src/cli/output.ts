import { Console, Effect } from "effect"
import type { PageResponse } from "../shared/api.ts"
import { formatLocalMinute, humanSize } from "../shared/format.ts"

// The Go CLI re-marshals its pageResp struct with every field present; keep
// the same JSON shape (and field order) for --json output.
export const normalizePage = (page: PageResponse) => ({
  id: page.id,
  url: page.url,
  title: page.title,
  slug: page.slug ?? "",
  raw: page.raw,
  created_at: page.created_at,
  updated_at: page.updated_at,
  expires_at: page.expires_at ?? null,
  size: page.size ?? 0
})

export const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

// report prints a page result. When jsonOut is true it prints the raw JSON;
// otherwise it prints a human summary with the URL on its own line. verb, when
// non-empty, prefixes a "✓ <verb>" headline (used by create/update).
export const report = (page: PageResponse, jsonOut: boolean, verb: string) =>
  Effect.gen(function* () {
    if (jsonOut) {
      yield* printJson(normalizePage(page))
      return
    }
    if (verb !== "") {
      yield* Console.log(`✓ ${verb} ${JSON.stringify(page.title)}`)
    } else {
      yield* Console.log(page.title)
    }
    yield* Console.log(page.url)

    let meta = `  id ${page.id}`
    if (page.raw) meta += " · raw"
    const size = page.size ?? 0
    if (size > 0) meta += ` · ${humanSize(size)}`
    if (page.expires_at !== null && page.expires_at !== undefined) {
      meta += ` · expires ${formatLocalMinute(page.expires_at)}`
    }
    yield* Console.log(meta)
  })
