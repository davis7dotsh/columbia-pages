# Self-Host on Railway

Railway is the blessed deployment path for Columbia Pages. The service is one
container plus one persistent volume.

## Prerequisites

- A Railway account
- A GitHub repository containing Columbia Pages
- The `cpages` CLI, or the latest patch release of Go 1.25+ to install it

## Deploy

1. In Railway, create a project from the GitHub repository.
2. Select the repository root. Railway detects `Dockerfile` and `railway.json`.
3. Add a volume to the service and mount it at `/data`.
4. Generate a public domain under service networking.
5. Add the service variables below.
6. Wait for `/healthz` to report a healthy deployment.

The volume is required. Without it, all pages disappear on the next deployment.

## Variables

Set:

```text
COLUMBIA_PAGES_PASSCODE=<at least 32 random bytes>
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Do not set `PORT`; Railway supplies it. The container defaults `DB_PATH` to
`/data/columbia-pages.db`.

Generate a secret locally with either:

```bash
openssl rand -base64 48
```

or Railway's template secret generator when deploying from a published
template. Never commit this value or paste it into an agent prompt.

## Connect the CLI

```bash
go install github.com/davis7dotsh/columbia-pages/cmd/cpages@latest
cpages login --server https://your-service.up.railway.app
cpages status
```

Paste the Railway passcode into the hidden prompt. Do not put it directly on a
command line. The `Auth` line from `cpages status` should say `authenticated`
and exit 0.

This flow is identical for a brand-new deployment and an existing instance.
Running `cpages login --server <url>` replaces the CLI's saved connection, so it
is also how you switch between instances.

## Smoke Test

```bash
cpages create --title "Railway smoke test" - <<'HTML'
<header><h1>Railway smoke test</h1></header>
<p>The service, CLI, database, and public route are working.</p>
HTML
```

Open the printed URL, then remove the page when finished:

```bash
cpages delete <id>
```

## Custom Domain

Add the domain in Railway service networking, configure the requested DNS
record, and change `PUBLIC_BASE_URL` to the final HTTPS origin. Re-run
`cpages login --server <new-origin>` so the CLI uses it.

## Back Up the Database

SQLite runs in WAL mode. Do not copy only `columbia-pages.db` while the service
is actively writing; committed data may still be in sidecar files.

Use Railway's volume backup feature instead:

1. Open the Columbia Pages service in Railway.
2. Open the **Backups** tab for the attached volume.
3. Create a manual backup before an upgrade.
4. Configure a daily, weekly, or monthly schedule for ongoing protection.

Restoring a Railway backup stages a replacement volume at the same mount path.
Review the staged change, deploy it, and verify `/healthz` plus `cpages status`.
Test restore procedures before relying on them. Railway does not currently
offer a direct volume file browser or download, and its managed backups remain
inside the same project and environment.

## Upgrade

For an existing Railway deployment:

1. Confirm the service still has its volume mounted at `/data` and that
   `DB_PATH` is `/data/columbia-pages.db` (the image default).
2. Create a manual volume backup from the service's **Backups** tab.
3. Confirm the service source points at this repository and the intended branch.
4. Push or merge the new commit. With GitHub autodeploy enabled, Railway builds
   it automatically after the connected branch updates.
5. If autodeploy is disabled, use Railway's command palette and choose
   **Deploy Latest Commit**. Do not use **Redeploy** for an upgrade: that action
   rebuilds the already-selected deployment rather than fetching newer code.
6. Wait for the `/healthz` check to pass, then run `cpages status` and publish a
   smoke-test page.

The SQLite database remains on the mounted volume across image deployments.
This revision does not change the `pages` schema, so no data migration is
required. Railway prevents two deployments from mounting one volume at once,
so expect a short interruption while the new deployment replaces the old one.

If the new deployment fails, open the service's **Deployments** tab and roll
back to the previous successful deployment. Railway rollback restores that
deployment's image and custom variables; the persistent volume remains the
service's data source.

Your existing CLI login continues to work after an upgrade as long as the
public URL and `COLUMBIA_PAGES_PASSCODE` do not change.

## Device Login Status

Device login is not implemented in this revision. The running server and CLI
still use `COLUMBIA_PAGES_PASSCODE`, so upgrading an existing Railway service
does not create an activation page or issue device tokens.

The intended protocol and safe migration sequence are documented in
[`docs/device-authorization.md`](../device-authorization.md). Implementing it
requires token storage, approval endpoints, CLI polling, owner authentication,
and separate control and content origins before it can be enabled safely.

## Production Checklist

- The service uses HTTPS.
- A persistent volume is mounted at `/data`.
- `COLUMBIA_PAGES_PASSCODE` is long, unique, and stored only in Railway and
  local CLI configuration.
- `PUBLIC_BASE_URL` is the canonical public origin.
- The generated domain or custom domain reaches `/healthz`.
- Volume backups have been tested.
- Published content contains no secrets.

## Railway Template

After the repository is public, publish a Railway Template that includes:

- One service sourced from this repository
- A generated public domain
- A volume mounted at `/data`
- `COLUMBIA_PAGES_PASSCODE=${{secret(64)}}`
- `PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`

Add the generated Deploy on Railway button to the top of `README.md`. Project-
level resources such as volumes and domains are template configuration; they
cannot be fully declared by `railway.json` alone.

Official references: [Railway templates](https://docs.railway.com/templates/create),
[variables](https://docs.railway.com/variables),
[volumes](https://docs.railway.com/volumes), and
[volume backups](https://docs.railway.com/volumes/backups),
[deployment actions](https://docs.railway.com/deployments/deployment-actions),
[GitHub autodeploys](https://docs.railway.com/guides/github-autodeploys), and
[public networking](https://docs.railway.com/public-networking).
