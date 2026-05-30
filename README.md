# Columbia Pages

A tiny personal tool for publishing **clean, shareable HTML pages** — sponsor
analyses, deal breakdowns, data tables, reports — and getting back a link.
Built to be driven by an agent (Hermes) via the `cpages` CLI.

Write some HTML, run one command, get a URL. Pages are styled by a built-in
**house theme** (minimal, robust, clean — system fonts, restrained color, auto
light/dark), so even a bare table looks good.

```
  agent ──writes──▶ /tmp/page.html ──cpages create──▶  server (Go)
                                                         │  SQLite (HTML inline)
  browser ◀───────  https://…/p/<id>  ◀─────────────────┘  public, unguessable URL
```

## Quick start

Deploy the server (see [Deploy to Railway](#deploy-to-railway)), then install and
log in the CLI:

```bash
# install the cpages CLI onto your PATH
go install ./cmd/cpages            # from a clone, or:
# go install github.com/davis7dotsh/columbia-pages/cmd/cpages@latest

# log in once (prompts for passcode, hidden)
cpages login --server https://columbia-pages.up.railway.app
cpages status                      # → Auth: ✓ authenticated
```

Publish a page — write **body content** (the house theme is added for you) and
upload it:

```bash
cat > /tmp/page.html <<'HTML'
<header>
  <h1>Aerolux Performance</h1>
  <p class="dek">Q3 renewal review — partnership health and recommended terms.</p>
</header>
<div class="callout ok"><span class="ico">✓</span><div class="body">
  <div class="title">Recommendation</div><p>Renew at a 12% increase.</p>
</div></div>
<div class="table-wrap"><table>
  <thead><tr><th>Cycle</th><th class="num">Spend</th><th>Status</th></tr></thead>
  <tbody><tr><td>2025 H2</td><td class="num">$124,000</td><td><span class="badge ok">On track</span></td></tr></tbody>
</table></div>
HTML

cpages create --title "Aerolux — Sponsor Analysis" /tmp/page.html
# ✓ Published "Aerolux — Sponsor Analysis"
# https://columbia-pages.up.railway.app/p/0CF69gUPDjKM
```

Open the printed URL in any browser. See `theme/demo.html` for every component
the house theme offers, and `.skills/columbia-pages/SKILL.md` for the full set of
copy-paste snippets the agent uses.

## How it works

- **Server** (`cmd/server`) — Go HTTP service. A passcode-protected JSON API
  manages pages; pages are viewable at public, unguessable URLs (`/p/{id}`).
- **Storage** — one SQLite file with the HTML stored inline. No blob store, no
  external DB. Back it up by copying the file.
- **Theme** — `theme/theme.css` is embedded in the binary and served at
  `/theme.css`. Themed pages are body content wrapped in a full document that
  links it. `theme/demo.html` previews the design standalone.
- **CLI** (`cmd/cpages`) — uploads a file and prints the link; also lists,
  fetches, updates, and deletes pages.
- **Skill** (`.skills/columbia-pages/SKILL.md`) — instructions that teach the
  agent when to publish and how to write to the house theme.

## Layout

```
columbia-pages/
├── cmd/server/         HTTP server entrypoint
├── cmd/cpages/         CLI client
├── internal/store/     SQLite persistence (HTML inline)
├── internal/web/       routing, auth, themed rendering, id generation
├── theme/              theme.css (source of truth) · theme.go (embed) · demo.html
├── .skills/columbia-pages/SKILL.md      the agent skill (source of truth)
├── .claude/skills/columbia-pages →      symlink to ../../.skills/columbia-pages
├── Dockerfile · railway.json · .env.example
```

## Configuration

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `COLUMBIA_PAGES_PASSCODE` | server + CLI | — | shared API secret (required by server; CLI usually gets it from `cpages login`) |
| `DB_PATH` | server | `./columbia-pages.db` | point at a volume in prod |
| `PORT` | server | `8080` | Railway sets this |
| `PUBLIC_BASE_URL` | server | derived from request | your real domain in prod |
| `COLUMBIA_PAGES_URL` | CLI | — | server base URL (or use `cpages login`) |
| `COLUMBIA_PAGES_CONFIG_DIR` | CLI | `~/.config/columbia-pages` | where login is saved |

## Local development

```bash
go mod tidy            # resolve modernc.org/sqlite + write go.sum

# terminal 1 — server
COLUMBIA_PAGES_PASSCODE=dev-secret go run ./cmd/server

# terminal 2 — CLI: log in once, then publish
go run ./cmd/cpages login --server http://localhost:8080 --passcode dev-secret
go run ./cmd/cpages create --title "Hello" page.html   # any body-content HTML
# → prints http://localhost:8080/p/<id>
```

Build binaries:

```bash
go build -o bin/server ./cmd/server
go build -o bin/cpages ./cmd/cpages
```

## Deploy to Railway

1. Push this directory to a repo and create a Railway project from it. Railway
   detects the `Dockerfile` (and `railway.json`).
2. **Add a Volume** and mount it at `/data`. The image already sets
   `DB_PATH=/data/columbia-pages.db`, so the database persists across deploys.
3. **Set variables**:
   - `COLUMBIA_PAGES_PASSCODE` = a long random secret
   - `PUBLIC_BASE_URL` = your public URL (e.g. `https://columbia-pages.up.railway.app`)
   - (`PORT` is provided by Railway.)
4. Deploy. Health check is `GET /healthz`.

Then point the CLI at it:

```bash
export COLUMBIA_PAGES_URL=https://columbia-pages.up.railway.app
export COLUMBIA_PAGES_PASSCODE=<same secret>
```

## CLI reference

```
cpages login   [--server URL] [--passcode P]   save credentials (prompts if omitted)
cpages logout                                  forget saved credentials
cpages status                                  show config + whether auth works

cpages create  --title "Title" [--slug s] [--raw] [--ttl N] <file|->
cpages list    [--limit N] [--json]
cpages get     <id> [--json]
cpages update  [--title T] [--slug s] [--raw] [--ttl N] <id> [<file|->]
cpages delete  <id>
cpages version
```

- **Run `cpages login` once.** It prompts for the server URL and passcode (hidden
  input), verifies them against the server, and saves them to
  `~/.config/columbia-pages/config.json` (mode `0600`). Every command reads from
  there automatically — no env vars needed.
- Credential precedence: `--server`/`--passcode` flag → `COLUMBIA_PAGES_URL`/
  `COLUMBIA_PAGES_PASSCODE` env → saved config.
- Default upload is **body content** wrapped in the house theme. `--raw` serves
  a complete HTML document verbatim.
- `--ttl N` auto-deletes after N days (`0` = never). On `update`, `--ttl 0`
  clears an existing expiry.
- Put flags **before** positional arguments. Use `-` as the file to read stdin.

## HTTP API

All `/api/*` routes require `Authorization: Bearer <passcode>`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/pages` | `{title, html, raw?, slug?, ttl_days?}` | create |
| `GET` | `/api/pages?limit=N` | — | list metadata |
| `GET` | `/api/pages/{id}` | — | one page's metadata |
| `PUT` | `/api/pages/{id}` | any of `{title, html, raw, slug, ttl_days}` | update |
| `DELETE` | `/api/pages/{id}` | — | delete |

Public (no auth): `GET /p/{id}` (the page), `GET /theme.css`, `GET /healthz`.

## The agent skill

The skill that teaches the agent how/when to publish lives at
`.skills/columbia-pages/` (the source of truth) and is symlinked into
`.claude/skills/columbia-pages`, so **Claude Code picks it up automatically when
working inside this repo** — nothing to install. The symlink is committed, so it
works for anyone who clones the repo too.

To make the skill available to an agent **globally** (any working directory),
also symlink it into your personal skills dir:

```bash
ln -s "$PWD/.skills/columbia-pages" ~/.claude/skills/columbia-pages
```

Either way, run `cpages login` once as the user the agent runs as; the saved
config is picked up automatically — no environment variables required.
