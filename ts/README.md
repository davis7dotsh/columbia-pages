# Columbia Pages — TypeScript / Effect port (experiment)

A full recreation of Columbia Pages in TypeScript on [Effect v4
beta](https://effect.website/blog/releases/effect/40-beta/), running on Bun and
compiled to native binaries with `bun build --compile`. The Go implementation
at the repository root remains canonical; this port exists to compare the two
stacks feature-for-feature.

Everything is built from Effect primitives: `effect/unstable/cli` for the
`cpages` CLI, `effect/unstable/http` for the server and HTTP client,
`@effect/sql-sqlite-bun` over `bun:sqlite` for storage, `Layer` for wiring,
`Config` for environment, `Schema` for every wire format, and
`@effect/language-service` for compile-time Effect diagnostics.

## Layout

| Go | TypeScript |
|---|---|
| `cmd/server/main.go` | `src/server/main.ts` (layers, server, sweeper) |
| `cmd/cpages/main.go` | `src/cli/main.ts` (commands via `effect/unstable/cli`) |
| `cmd/cpages/config.go` | `src/cli/config.ts` (`CliConfig` service) |
| `cmd/cpages/device_login.go` | `src/cli/deviceLogin.ts` |
| `internal/store/store.go` | `src/server/pagesStore.ts` (`PagesStore` service) |
| `internal/store/auth.go` | `src/server/authStore.ts` (`AuthStore` service) |
| `internal/web/server.go` | `src/server/routesPublic.ts`, `routesApi.ts`, `gate.ts` |
| `internal/web/auth.go` | `src/server/routesDeviceAuth.ts`, `authn.ts`, `rateLimiter.ts` |
| `internal/web/admin.go` | `src/server/routesAdmin.ts` |
| `internal/web/id.go` | `src/shared/crypto.ts` |
| `theme/theme.go` (`//go:embed`) | `src/server/theme.ts` (`with { type: "text" }`) |

The theme stays in exactly one place — `../theme/theme.css` — imported as text
and inlined into the compiled binary, so the single-source-of-truth invariant
holds across both implementations.

## Build, run, test

```bash
bun install
bun run check        # tsc + effect-language-service diagnostics (--strict)
bun test             # 37 tests: stores, device-auth flow, ids, origins, rendering
bun run build        # native binaries at bin/server and bin/cpages
```

Run locally (same environment contract as the Go server):

```bash
COLUMBIA_PAGES_ADMIN_PASSCODE=dev-admin-secret \
PUBLIC_BASE_URL=http://pages.localhost:8080 \
CONTROL_BASE_URL=http://control.localhost:8080 \
DB_PATH=/tmp/columbia-pages-ts.db PORT=8080 ./bin/server
```

```bash
export COLUMBIA_PAGES_CONFIG_DIR=/tmp/cpages-ts-cfg   # isolate from a real login
./bin/cpages login --server http://pages.localhost:8080
printf '<h1>Hi</h1>' | ./bin/cpages create --title "Smoke" -
```

Do not add `--minify` to the build: Bun's minifier is known to break Effect's
fiber runtime in compiled binaries
([effect-smol#2126](https://github.com/Effect-TS/effect-smol/issues/2126)).

## How Go concepts map to Effect

- **Env config + validation** (`cmd/server` flag parsing) → `Config.*` readers
  inside a `ServerConfig` service; invalid origins fail layer construction, so
  the process exits before binding, exactly like `log.Fatal`.
- **`http.ServeMux` + host gating** → `HttpRouter` route layers plus one global
  `HttpRouter.middleware`: misdirected hosts get 421 before the handler runs,
  control-origin responses gain the no-store/CSP headers, and every request is
  logged with `/p/…` and `/api/pages/…` redaction.
- **`context.Context` cancellation + graceful shutdown** → structured
  concurrency: `BunRuntime.runMain` interrupts the main fiber on SIGINT/SIGTERM
  and layer finalizers stop the server and close SQLite.
- **The hourly expiry sweeper goroutine** → a scoped fiber
  (`Effect.forkScoped`) owned by a layer, interrupted automatically on
  shutdown.
- **`database/sql` + transactions** → `SqlClient` tagged-template statements
  with `sql.withTransaction`. One subtlety the tests caught: Go commits poll
  bookkeeping and then returns sentinel errors, while a failed Effect
  transaction rolls back — so `pollDeviceAuthorization` returns
  pending/slow-down as *values* from the transaction and raises them as typed
  failures afterwards.
- **Sentinel errors (`ErrNotFound`, `ErrGrantPending`, …)** → tagged error
  classes handled with `Effect.catchTag(s)`; being yieldable, handlers read as
  `return yield* new GrantDenied()`.
- **`crypto/rand`, HMAC, constant-time compares** → the same primitives from
  `node:crypto`, wrapped in `Effect.sync` where effectful.
- **CLI flag sets** → `Command.make` with `Flag`/`Argument`; `fs.Visit`
  set-detection becomes `Flag.optional` returning `Option`.
- **Secrets** → the admin passcode is a `Redacted<string>` end to end.

## Known deviations from the Go implementation

- Wrong HTTP method on an existing path returns 404 (via the wildcard
  fallback route), where Go's `ServeMux` returns 405.
- The 8 MiB upload cap is enforced by Bun's `maxRequestBodySize` (413), not
  `http.MaxBytesReader` (400); admin forms share that global cap instead of a
  separate 64 KiB one.
- Timestamps carry millisecond precision (`Date.toISOString()`), not Go's
  variable-precision RFC 3339 nanoseconds. Both stores compare correctly.
- `cpages --version` prints `cpages v0.1.0` (framework format); the `version`
  subcommand prints `cpages 0.1.0` like Go.
- CLI parse errors print the framework's usage + error block rather than Go's
  one-line message. Handler errors match Go exactly: `error: <message>`,
  exit 1.
- The interactive server-URL prompt uses `Prompt.text` (a real terminal
  prompt) instead of a bare stderr read.
- Binaries weigh ~95 MB (embedded Bun runtime) vs roughly 15 MB for static Go.

## Status

Verified end to end against a local instance: device login with browser
approval (admin session, CSRF, rate limits), create/list/get/update/delete,
themed rendering byte-compatible with the Go server's shell, host gating,
token revocation on logout — both under `bun run` and as compiled binaries.
