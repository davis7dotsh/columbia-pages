# Security Policy

## Reporting a Vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a
public issue containing exploit details, credentials, unlisted page URLs, or
deployment configuration.

Include the affected version, deployment assumptions, reproduction steps,
impact, and any suggested mitigation.

## Supported Versions

Until the first tagged release, only the latest commit on `main` is supported.

## Content Trust Model

Columbia Pages stores and serves publisher-supplied HTML. It does not sanitize
themed body content, and raw pages may contain JavaScript. Treat publishing
credentials as trusted-code-authority for the page origin.

Public page URLs are unguessable but are not access control. Anyone with a URL
can view the page. Do not publish secrets or information that requires identity-
based authorization.

The management API uses a bearer passcode. Use HTTPS outside loopback
development, keep the passcode out of command-line arguments and logs, and
rotate it after suspected exposure.

## Browser Authentication

Do not add browser sessions, approval cookies, or administrative UI to the same
origin that serves `/p/*`. Active published HTML must live on a separate content
origin from browser-authenticated control surfaces. See
[`docs/device-authorization.md`](docs/device-authorization.md).

## Deployment

- Mount persistent storage at `/data`.
- Use a unique, high-entropy `COLUMBIA_PAGES_PASSCODE`.
- Set `PUBLIC_BASE_URL` to the canonical HTTPS origin.
- Back up the complete SQLite volume consistently, including WAL state.
- Do not bake `.env`, databases, credentials, or local build output into images.
