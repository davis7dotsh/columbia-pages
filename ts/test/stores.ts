import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AuthStore, AuthStoreLive } from "../src/server/authStore.ts"
import { SCHEMA_STATEMENTS } from "../src/server/db.ts"
import { PagesStore, PagesStoreLive } from "../src/server/pagesStore.ts"

// A fresh in-memory database per call, so every test is isolated.
export const testStores = () => {
  const client = SqliteClient.layer({ filename: ":memory:" })
  const migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const statement of SCHEMA_STATEMENTS) {
        yield* sql.unsafe(statement)
      }
    })
  ).pipe(Layer.provideMerge(client))
  return Layer.mergeAll(PagesStoreLive, AuthStoreLive).pipe(Layer.provideMerge(migrated))
}

export const runWithStores = <A, E>(
  effect: Effect.Effect<A, E, PagesStore | AuthStore>
): Promise<A> => Effect.runPromise(Effect.provide(effect, testStores()) as Effect.Effect<A, E>)
