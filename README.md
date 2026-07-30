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

> **Giving this repository URL to an agent?** Start with
> [Agent Setup](docs/agent-setup.md). It has separate, end-to-end checklists for
> connecting a new device to an existing instance and deploying a new Railway
> instance from scratch.

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

If someone has already deployed Columbia Pages, ask for its public HTTPS URL,
then run:

```bash
cpages login --server https://your-service.up.railway.app
cpages status
```

`login` prints an activation URL and short code. Open the URL, sign in with the
deployment's admin passcode, review the requested scopes, and approve the
device. The CLI receives a revocable 90-day token and saves it in
`~/.config/columbia-pages/config.json` with mode `0600`. A successful status
check identifies the token, scopes, label, and expiry. Run login again to switch
instances or replace a token.

### 3. Or deploy and connect a new Railway instance

Create a Railway project from this repository, attach a volume at `/data`, and
give the same service two domains: one for public content and one for the
control plane. Set:

```text
COLUMBIA_PAGES_ADMIN_PASSCODE=<a long random owner secret>
PUBLIC_BASE_URL=https://pages.example.com
CONTROL_BASE_URL=https://your-service.up.railway.app
```

Railway supplies `PORT`; the container stores SQLite at
`/data/columbia-pages.db` and exposes `/healthz`. Published HTML is active, so
the two origins are a security requirement even though both route to the same
container.

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
- `cmd/cpages` manages login, pages, and file uploads.
- `internal/store` persists page HTML, uploaded files, and metadata in one SQLite database.
- `internal/web` serves the authenticated API and public page/file URLs.
- `theme/theme.css` is embedded into the server binary.
- `.skills/columbia-pages` teaches agents how to publish accessible reports.

Themed pages store body HTML and are wrapped by the server. Raw pages store and
serve a complete document verbatim.

## CLI

```text
cpages login   [--server URL] [--device-name NAME] [--read-only]
cpages logout
cpages status

cpages create  --title "Title" [--slug s] [--raw] [--ttl N] <file|->
cpages upload  [--name NAME] [--type MIME] [--ttl N] <file|->
cpages list    [--limit N] [--json]
cpages get     [--json] <id>
cpages update  [--title T] [--slug s] [--raw] [--ttl N] <id> [<file|->]
cpages delete  <id>
```

Put flags before positional arguments. Use `-` to read page HTML or file data
from stdin; file uploads from stdin require `--name`. `upload` detects the MIME
type from the filename/content unless `--type` is supplied, then returns a
public, unguessable URL. Uploads are limited to 128 MiB.

## Security Model

- The management API accepts scoped, revocable device tokens on the control
  origin.
- Public page IDs contain roughly 71 bits of randomness.
- Public file IDs contain the same roughly 71 bits of randomness.
- Page HTML is trusted publisher content and is not sanitized.
- Raw pages may execute JavaScript.
- CLI credentials are stored in `~/.config/columbia-pages/config.json` with
  mode `0600`.

Read [SECURITY.md](SECURITY.md) before exposing an instance publicly. Browser
authentication never shares an origin with published page HTML. The protocol
and token lifecycle are documented in
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
export COLUMBIA_PAGES_ADMIN_PASSCODE=dev-admin-secret
export PUBLIC_BASE_URL=http://pages.localhost:8080
export CONTROL_BASE_URL=http://control.localhost:8080
export DB_PATH=/tmp/columbia-pages.db
go run ./cmd/server
```

In another terminal:

```bash
export COLUMBIA_PAGES_CONFIG_DIR=/tmp/columbia-pages-config
cpages login --server http://pages.localhost:8080
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository
guidance.

## License

Columbia Pages is available under the [MIT License](LICENSE).
