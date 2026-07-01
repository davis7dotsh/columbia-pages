export const schema = `
CREATE TABLE IF NOT EXISTS pages (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  slug       TEXT NOT NULL DEFAULT '',
  html       TEXT NOT NULL,
  raw        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_created ON pages(created_at);
CREATE INDEX IF NOT EXISTS idx_pages_expires ON pages(expires_at);

CREATE TABLE IF NOT EXISTS device_authorizations (
  id                    TEXT PRIMARY KEY,
  device_code_hash      TEXT NOT NULL UNIQUE,
  device_secret_hash    TEXT NOT NULL,
  user_code_hash        TEXT NOT NULL UNIQUE,
  device_label          TEXT NOT NULL,
  scopes                 TEXT NOT NULL,
  source_key             TEXT NOT NULL,
  source_hint            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  approved_at            TEXT,
  denied_at              TEXT,
  last_poll_at           TEXT,
  poll_interval_seconds  INTEGER NOT NULL,
  consumed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_authorizations_user_code ON device_authorizations(user_code_hash);
CREATE INDEX IF NOT EXISTS idx_device_authorizations_source ON device_authorizations(source_key, status);
CREATE INDEX IF NOT EXISTS idx_device_authorizations_expires ON device_authorizations(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  display_prefix  TEXT NOT NULL,
  device_label    TEXT NOT NULL,
  scopes          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  last_used_at    TEXT,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens(expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id            TEXT PRIMARY KEY,
  session_hash  TEXT NOT NULL UNIQUE,
  authenticated INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_hash ON admin_sessions(session_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);`
