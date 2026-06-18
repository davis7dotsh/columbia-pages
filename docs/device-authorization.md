# Device Authorization Design

This document specifies the planned browser-assisted CLI login. It is a design,
not an implemented API.

## Goal

An agent should be able to run:

```bash
cpages login --server https://control.example.com
```

The CLI prints a verification URL and short code, waits, and receives a scoped
device token after the deployment owner approves it in a browser. The root
deployment passcode never enters the agent environment.

## Security Boundary

Published Columbia Pages HTML is active publisher-controlled content. Raw pages
may execute JavaScript, and themed page bodies are not sanitized.

The browser control plane must therefore use a different origin from published
pages:

```text
control.example.com  admin login, device approval, API
pages.example.com    public /p/<id> content
```

Host-only admin cookies must never be sent to the content origin. A same-origin
approval UI is unsafe even when cookies are `HttpOnly`, because page JavaScript
could exercise authenticated control-plane requests.

## Protocol

1. The CLI generates a random 256-bit device secret.
2. `POST /api/auth/device/code` creates a pending request.
3. The server returns a short user code, verification URL, expiry, and polling
   interval.
4. The CLI prints the URL and code, then polls
   `POST /api/auth/device/token`.
5. The owner signs in to the control origin, reviews the device and requested
   scopes, and approves or denies the request.
6. The next valid poll atomically consumes the grant and returns a device token.
7. The CLI stores the token in its mode-`0600` configuration file.

Use OAuth device-flow response semantics:

```text
authorization_pending
slow_down
access_denied
expired_token
```

## Owner Authentication

Code entry alone is not authorization. If anonymous visitors can both request
and approve device codes, anyone can mint a token.

The first version should authenticate the owner with a dedicated
`COLUMBIA_PAGES_ADMIN_PASSCODE`, then issue a short first-party admin session:

- `Secure`
- `HttpOnly`
- `SameSite=Strict`
- host-only for the control origin
- approximately 30-day lifetime

State-changing admin forms require CSRF tokens. Never store the admin passcode
itself in a cookie.

## Endpoints

```text
POST /api/auth/device/code
POST /api/auth/device/token
POST /api/auth/revoke

GET  /activate
POST /activate
GET  /admin/login
POST /admin/login
POST /admin/logout
GET  /admin/tokens
POST /admin/tokens/{id}/revoke
```

The device-code and polling endpoints are public but rate limited. Approval and
token management require an authenticated owner session.

## Storage

`device_authorizations` stores:

- hashes of the device secret and normalized user code
- device label and requested scopes
- pending, approved, denied, or consumed state
- created, expiry, approval, last-poll, and consumed timestamps
- polling interval

`api_tokens` stores:

- token ID and SHA-256 token hash
- non-secret display prefix and device label
- scopes
- created, expiry, last-used, and revoked timestamps

Never store raw device secrets or API tokens.

## Tokens and Scopes

Use an identifiable token format such as:

```text
cpages_<public-id>.<32-random-bytes>
```

Initial device scopes:

```text
pages:read
pages:write
```

Device tokens cannot manage other tokens or approve devices. Use a finite
default lifetime, expose revocation, and update `last_used_at` without making it
a synchronous write bottleneck.

## Abuse Controls

- Expire pending device grants after 10 minutes.
- Poll no faster than every 5 seconds; return `slow_down` and `Retry-After`.
- Rate limit creation, user-code lookup, admin login, and polling.
- Cap pending grants per instance and source address.
- Use generic invalid or expired code responses.
- Display device label, requested scopes, request time, and approximate source
  before approval.
- Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a restrictive
  CSP, and `frame-ancestors 'none'` on control pages.
- Build all control URLs from configured origins, never forwarded host headers.

## Migration

1. Add token authentication and scope enforcement while retaining the shared
   passcode.
2. Add device grants, polling state transitions, expiry, and revocation.
3. Add the isolated control-host UI and owner sessions.
4. Make normal `cpages login` use device authorization.
5. Continue reading legacy `passcode` config for one migration release.
6. Disable direct root-passcode page management after device login is stable.

Each stage requires tests for expiry, replay, polling throttles, denial,
revocation, scope enforcement, CSRF, and content/control origin isolation.
