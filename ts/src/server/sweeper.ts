import { Console, Duration, Effect, Layer } from "effect"
import { nowIso } from "../shared/time.ts"
import { AuthStore } from "./authStore.ts"
import { PagesStore } from "./pagesStore.ts"

const sweepOnce = Effect.gen(function* () {
  const pages = yield* PagesStore
  const auth = yield* AuthStore
  const now = yield* nowIso
  const removedPages = yield* pages.deleteExpired(now).pipe(
    Effect.catchTag("SqlError", (error) =>
      Console.log(`expiry sweep: ${error}`).pipe(Effect.as(0))
    )
  )
  if (removedPages > 0) yield* Console.log(`expiry sweep: removed ${removedPages} page(s)`)
  const removedAuth = yield* auth.deleteExpiredAuth(now).pipe(
    Effect.catchTag("SqlError", (error) =>
      Console.log(`auth expiry sweep: ${error}`).pipe(Effect.as(0))
    )
  )
  if (removedAuth > 0) yield* Console.log(`auth expiry sweep: removed ${removedAuth} record(s)`)
})

// Runs once at startup, then hourly for the lifetime of the server scope —
// the fiber is interrupted automatically on shutdown.
export const SweeperLive = Layer.effectDiscard(
  Effect.forkScoped(
    sweepOnce.pipe(Effect.andThen(Effect.sleep(Duration.hours(1))), Effect.forever)
  )
)
