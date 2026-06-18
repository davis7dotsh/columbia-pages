# Columbia Pages

Columbia Pages is a small self-hosted service for publishing clean HTML reports
and getting back a shareable URL. It includes a Go server, SQLite storage, the
`cpages` CLI, a built-in report theme, and an agent skill.

```text
agent -> cpages CLI -> authenticated API -> SQLite
                                      |
browser <- public unguessable URL <---+
```

Published pages are public to anyone who has their URL. Columbia Pages is best
for reports you intend to share, not for storing secrets.

## Quick Start

### 1. Install the CLI

Install with the latest patch release of Go 1.25 or newer:

```bash
go install github.com/davis7dotsh/columbia-pages/cmd/cpages@latest
```

Make sure `$(go env GOPATH)/bin` is on `PATH`, then confirm the install:

```bash
cpages version
```

### 2. Connect to an existing instance

If someone has already deployed Columbia Pages, ask them for its HTTPS URL and
`COLUMBIA_PAGES_PASSCODE`, then run:

```bash
cpages login --server https://your-service.up.railway.app
cpages status
```

`login` prompts for the passcode without echoing it, verifies the server, and
saves the connection in `~/.config/columbia-pages/config.json`. A successful
status check has an `Auth` line that says `authenticated` and exits with status
0. Run `cpages login --server <new-url>` again whenever you want to switch the
CLI to a different instance.

### 3. Or deploy and connect a new Railway instance

Create a Railway project from this repository, attach a volume at `/data`, and
set these service variables:

```text
COLUMBIA_PAGES_PASSCODE=<a long random secret>
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Generate a public domain for the service. Railway supplies `PORT`; the container
already stores SQLite at `/data/columbia-pages.db` and exposes `/healthz`.

After Railway reports the deployment healthy, connect exactly as you would to
an existing instance:

```bash
cpages login --server https://your-service.up.railway.app
cpages status
```

See [the complete Railway guide](docs/self-hosting/railway.md) for agent-friendly
deployment steps, backups, custom domains, upgrades, and production notes.

### 4. Publish

```bash
cpages create --title "First report" - <<'HTML'
<header>
  <h1>First report</h1>
  <p class="dek">A small report published from the command line.</p>
</header>
<section>
  <h2>Summary</h2>
  <p>Columbia Pages is ready.</p>
</section>
HTML
```

The command prints the public URL. Body-only HTML receives the house theme
automatically.

## Agent Skill

The source skill is [`.skills/columbia-pages`](.skills/columbia-pages). From a
clone, link it into the skill directory used by your agent:

```bash
git clone https://github.com/davis7dotsh/columbia-pages.git
cd columbia-pages
mkdir -p ~/.agents/skills
ln -s "$(pwd)/.skills/columbia-pages" ~/.agents/skills/columbia-pages
```

For a product-specific location, replace `~/.agents/skills` in both commands
with `~/.codex/skills` or `~/.claude/skills`. The committed
`.claude/skills/columbia-pages` symlink also makes the skill available to Claude
Code while working in this repository.

The skill treats the theme as a flexible component vocabulary. Semantic HTML
works without a fixed report template.

## How It Works

- `cmd/server` runs the HTTP service.
- `cmd/cpages` manages login and pages.
- `internal/store` persists page HTML and metadata in one SQLite database.
- `internal/web` serves the authenticated API and public page URLs.
- `theme/theme.css` is embedded into the server binary.
- `.skills/columbia-pages` teaches agents how to publish accessible reports.

Themed pages store body HTML and are wrapped by the server. Raw pages store and
serve a complete document verbatim.

## CLI

```text
cpages login   [--server URL]
cpages logout
cpages status

cpages create  --title "Title" [--slug s] [--raw] [--ttl N] <file|->
cpages list    [--limit N] [--json]
cpages get     [--json] <id>
cpages update  [--title T] [--slug s] [--raw] [--ttl N] <id> [<file|->]
cpages delete  <id>
```

Put flags before positional arguments. Use `-` to read page HTML from stdin.

## Security Model

- The management API requires a bearer passcode.
- Public page IDs contain roughly 71 bits of randomness.
- Page HTML is trusted publisher content and is not sanitized.
- Raw pages may execute JavaScript.
- CLI credentials are stored in `~/.config/columbia-pages/config.json` with
  mode `0600`.

The current release uses passcode login. Browser-assisted device authorization
is a planned design, not an implemented feature; deploying this revision does
not add device login.

Read [SECURITY.md](SECURITY.md) before exposing an instance publicly. Browser-
based authentication must not share an origin with published page HTML; the
planned approach is documented in
[docs/device-authorization.md](docs/device-authorization.md).

## Development

```bash
go test ./...
go vet ./...
gofmt -w .
```

Run the local service with an isolated database and config directory. Plain
HTTP is accepted only for loopback development:

**Terminal 1:**
```bash
export COLUMBIA_PAGES_PASSCODE=dev-secret
export DB_PATH=/tmp/columbia-pages.db
go run ./cmd/server
```

In another terminal:

```bash
export COLUMBIA_PAGES_CONFIG_DIR=/tmp/columbia-pages-config
cpages login --server http://localhost:8080
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository
guidance.

## License

Columbia Pages is available under the [MIT License](LICENSE).
