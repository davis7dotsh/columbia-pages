# AGENTS.md

Guidance for AI agents and human contributors working **on** this codebase.
(For how an agent *uses* the tool to publish pages, see
`.skills/columbia-pages/SKILL.md`.)

## What this is

**Columbia Pages** is a small self-hosted service for publishing clean, shareable
HTML pages — sponsor analyses, deal breakdowns, data tables, reports — and
getting back a public link. It's designed to be driven by an AI agent through
the `cpages` CLI.

Pieces:
- a **Go HTTP server** (scoped-token JSON API + public page views),
- **SQLite** storage with the page HTML stored inline (one file, no blob store),
- a **`cpages` CLI** the agent calls,
- a **house theme** (`theme/theme.css`) the server applies to every page,
- an **agent skill** that teaches agents when and how to publish.

## Data flow

```
owner browser ──▶ control origin /activate ──▶ scoped device token
                                                     │
agent writes body HTML ──▶ cpages create ──▶ control origin /api/pages ──▶ server
                                                                           │
                                                       SQLite (HTML inline) │
browser ◀── content origin /p/{id} (public) ◀── linked to /theme.css ◀──────┘
```

A **themed** page stores only the *body content*; the server wraps it in a full
document (`renderThemed` in `internal/web/server.go`) inside `<main class="page">`
and links `/theme.css`. A **raw** page stores a complete document and is served
verbatim.

## Repo layout

| Path | What |
|---|---|
| `cmd/server/main.go` | server entrypoint: config, expiry sweeper, graceful shutdown |
| `cmd/cpages/main.go` | CLI commands (`create`/`list`/`get`/`update`/`delete`/`login`/…) |
| `cmd/cpages/config.go` | CLI credential storage + resolution + hidden-input prompts |
| `internal/store/store.go` | SQLite persistence; `Page`/`Meta` models; CRUD + expiry sweep |
| `internal/web/server.go` | host gating, scoped auth, themed rendering, JSON handlers |
| `internal/web/id.go` | unguessable base62 page IDs (crypto/rand) |
| `theme/theme.css` | **the** house stylesheet (source of truth) |
| `theme/theme.go` | `//go:embed theme.css` → `theme.CSS` |
| `theme/demo.html` | standalone design preview linked to the source CSS |
| `.skills/columbia-pages/SKILL.md` | how the agent uses the tool (source of truth) |
| `.claude/skills/columbia-pages` | symlink → `../../.skills/columbia-pages` so Claude Code loads the skill in-repo |
| `Dockerfile`, `railway.json` | container build + Railway deploy |

## Build, run, test

```bash
go mod tidy                       # resolve deps + go.sum
go test ./... && go vet ./...     # test + vet everything
go build -o bin/server ./cmd/server
go build -o bin/cpages ./cmd/cpages
```

Run locally:

```bash
PUBLIC_BASE_URL=http://pages.localhost:8080 \
CONTROL_BASE_URL=http://control.localhost:8080 \
COLUMBIA_PAGES_PASSCODE=dev-legacy-secret \
COLUMBIA_PAGES_ADMIN_PASSCODE=dev-admin-secret \
COLUMBIA_PAGES_TOKEN_TTL_DAYS=90 \
DB_PATH=/tmp/cp.db PORT=8080 ./bin/server
```

Device tokens default to 90 days; the explicit TTL above makes that local
development behavior visible.

End-to-end smoke test (server must be running on :8080):

```bash
export COLUMBIA_PAGES_CONFIG_DIR=/tmp/cp-cfg     # isolate from your real login
export COLUMBIA_PAGES_PASSCODE=dev-legacy-secret
./bin/cpages login --legacy-passcode --server http://pages.localhost:8080
printf '<h1>Hi</h1><p>It works.</p>' > /tmp/body.html
./bin/cpages create --title "Smoke" /tmp/body.html   # prints the URL
./bin/cpages list
```

Tests cover CLI credential handling, storage lifecycle and permissions, API
authentication, rendering headers, and page-path log redaction. Add focused
regression tests alongside behavior changes.

## Conventions & invariants — read before changing things

- **Standard library first.** The server uses only stdlib + `modernc.org/sqlite`.
  The CLI uses only stdlib + `golang.org/x/term` (hidden passcode input).
- **`modernc.org/sqlite` is pure Go on purpose.** Do **not** swap in
  `mattn/go-sqlite3` — it needs cgo and would break the `CGO_ENABLED=0` static
  Docker build.
- **The `go` directive is `1.25`** (pulled up by `x/term`). The Dockerfile build
  image must be ≥ that (`golang:1.25-alpine`). If a dep bumps it again, bump the
  image too.
- **Themed vs raw is a hard contract.** Themed content must be *body only* — no
  `<!doctype>`, `<html>`, `<head>`, or `<style>`; the server adds those. Raw
  content must be a complete document. Don't blur the two.
- **The theme lives in exactly one place: `theme/theme.css`.** It's embedded into
  the binary and served at `/theme.css`. `theme/demo.html` links the source file
  directly, so visual previews cannot drift from the embedded stylesheet.
- **Page IDs are public and unguessable** (12 base62 chars, crypto/rand). The
  scoped credential protects the *API*, not viewing — anyone with a link can
  view a page.
- **Auth uses scoped device tokens.** The control origin hosts APIs, owner
  sessions, approval, and revocation; the content origin hosts `/p/{id}` and
  `/theme.css`. The legacy passcode remains behind
  `COLUMBIA_PAGES_ALLOW_LEGACY_AUTH` for migration only.
- **CLI credentials** are saved by device login to
  `~/.config/columbia-pages/config.json` (mode `0600`). The server URL resolves
  by **flag → env → config**; credentials resolve by **environment token →
  environment passcode → saved token → saved passcode**. Never log or print
  credentials. The CLI refuses non-loopback plain HTTP.
- **Published HTML is active content.** Never collapse `CONTROL_BASE_URL` and
  `PUBLIC_BASE_URL` into one origin. Host gating and host-only admin cookies are
  security boundaries, not deployment conveniences.

## Common tasks

- **Change the look** → edit `theme/theme.css`, reopen `theme/demo.html` to
  inspect, rebuild the server (it re-embeds). Everything is driven by the CSS
  variables at the top of the file.
- **Add an API endpoint** → register the route in `New()` (`internal/web/server.go`),
  write the handler, and wrap it with `s.auth(...)` and the narrowest scope it
  requires. Return JSON via `s.writeJSON` / `s.writeErr`.
- **Add a CLI command** → add a `case` in the `main()` switch, a `cmdX` function,
  and a line in `usage()` (`cmd/cpages/main.go`).
- **Add a stored field** → update the schema in `migrate()` and the `Page`/`Meta`
  structs + `Create`/`Get`/`Save`/`List` in `internal/store/store.go`, then the
  API request/response structs in `internal/web/server.go`, then the CLI.

## Gotchas

- Don't commit secrets. `.env` and the SQLite files (`*.db`, `-wal`, `-shm`) are
  gitignored; the CLI's `config.json` lives outside the repo.
- SQLite uses WAL mode. Back up the complete database state during a write
  pause instead of copying only the main `.db` file.

## Deploy

Railway, via the `Dockerfile` + `railway.json`. Mount a volume at `/data` (the
image sets `DB_PATH=/data/columbia-pages.db`), attach distinct content and
control domains, and set the auth variables. Full steps are in
`docs/self-hosting/railway.md`.
