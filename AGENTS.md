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
- a **Go HTTP server** (passcode-protected JSON API + public page views),
- **SQLite** storage with the page HTML stored inline (one file, no blob store),
- a **`cpages` CLI** the agent calls,
- a **house theme** (`theme/theme.css`) the server applies to every page,
- an **agent skill** that teaches agents when and how to publish.

## Data flow

```
agent writes body HTML ──▶ cpages create ──POST /api/pages (Bearer passcode)──▶ server
                                                                                  │
                                                              SQLite (HTML inline)│
browser ◀── GET /p/{id}  (public, unguessable) ◀── linked to GET /theme.css ◀─────┘
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
| `internal/web/server.go` | routing, passcode auth, themed rendering, JSON handlers |
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
COLUMBIA_PAGES_PASSCODE=dev-secret DB_PATH=/tmp/cp.db PORT=8080 ./bin/server
```

End-to-end smoke test (server must be running on :8080):

```bash
export COLUMBIA_PAGES_CONFIG_DIR=/tmp/cp-cfg     # isolate from your real login
export COLUMBIA_PAGES_PASSCODE=dev-secret
./bin/cpages login --server http://localhost:8080
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
  passcode protects the *API*, not viewing — anyone with a link can view a page.
- **Auth is one shared passcode**, constant-time compared (`subtle`). No users,
  no sessions. `/api/*` needs `Authorization: Bearer <passcode>`; `/p/{id}`,
  `/theme.css`, `/healthz` are public.
- **CLI credentials** are saved by `cpages login` to
  `~/.config/columbia-pages/config.json` (mode `0600`). The server URL resolves
  by **flag → env → config**; the passcode resolves by **env → config**. Never
  log or print the passcode. The CLI has no secret-bearing flags and refuses
  non-loopback plain HTTP so credentials are not sent in cleartext.
- **Published HTML is active content.** Never put a browser-authenticated admin
  or device-approval UI on the same origin as `/p/*`. Follow
  `docs/device-authorization.md` for the planned control/content split.

## Common tasks

- **Change the look** → edit `theme/theme.css`, reopen `theme/demo.html` to
  inspect, rebuild the server (it re-embeds). Everything is driven by the CSS
  variables at the top of the file.
- **Add an API endpoint** → register the route in `New()` (`internal/web/server.go`),
  write the handler, and wrap it with `s.auth(...)` if it should require the
  passcode. Return JSON via `s.writeJSON` / `s.writeErr`.
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

Railway, via the `Dockerfile` + `railway.json`. Mount a volume at `/data`
(the image sets `DB_PATH=/data/columbia-pages.db`) and set
`COLUMBIA_PAGES_PASSCODE` and `PUBLIC_BASE_URL`. Full steps are in
`docs/self-hosting/railway.md`.
