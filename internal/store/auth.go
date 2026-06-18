package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	ErrGrantNotFound = errors.New("device authorization not found")
	ErrGrantExpired  = errors.New("device authorization expired")
	ErrGrantPending  = errors.New("device authorization pending")
	ErrGrantDenied   = errors.New("device authorization denied")
	ErrGrantConsumed = errors.New("device authorization consumed")
	ErrSlowDown      = errors.New("device authorization polling too quickly")
	ErrLimitReached  = errors.New("device authorization limit reached")
	ErrSessionLimit  = errors.New("admin session limit reached")
)

const maxAdminSessions = 256

type DeviceAuthorization struct {
	ID                  string
	DeviceCodeHash      string
	DeviceSecretHash    string
	UserCodeHash        string
	DeviceLabel         string
	Scopes              string
	SourceKey           string
	SourceHint          string
	Status              string
	CreatedAt           time.Time
	ExpiresAt           time.Time
	ApprovedAt          *time.Time
	DeniedAt            *time.Time
	LastPollAt          *time.Time
	PollIntervalSeconds int
	ConsumedAt          *time.Time
}

type APIToken struct {
	ID            string
	TokenHash     string
	DisplayPrefix string
	DeviceLabel   string
	Scopes        string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	LastUsedAt    *time.Time
	RevokedAt     *time.Time
}

type AdminSession struct {
	ID            string
	SessionHash   string
	Authenticated bool
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

func (s *Store) CreateDeviceAuthorization(g DeviceAuthorization, perSource, perInstance int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin device authorization: %w", err)
	}
	defer tx.Rollback()

	var sourceCount, totalCount int
	if err := tx.QueryRow(`SELECT count(*) FROM device_authorizations WHERE source_key = ? AND status = 'pending' AND expires_at > ?`, g.SourceKey, g.CreatedAt.UTC().Format(rfc)).Scan(&sourceCount); err != nil {
		return fmt.Errorf("count source grants: %w", err)
	}
	if err := tx.QueryRow(`SELECT count(*) FROM device_authorizations WHERE status = 'pending' AND expires_at > ?`, g.CreatedAt.UTC().Format(rfc)).Scan(&totalCount); err != nil {
		return fmt.Errorf("count pending grants: %w", err)
	}
	if sourceCount >= perSource || totalCount >= perInstance {
		return ErrLimitReached
	}
	_, err = tx.Exec(`INSERT INTO device_authorizations
		(id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint, status, created_at, expires_at, poll_interval_seconds)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
		g.ID, g.DeviceCodeHash, g.DeviceSecretHash, g.UserCodeHash, g.DeviceLabel, g.Scopes, g.SourceKey, g.SourceHint,
		g.CreatedAt.UTC().Format(rfc), g.ExpiresAt.UTC().Format(rfc), g.PollIntervalSeconds)
	if err != nil {
		return fmt.Errorf("create device authorization: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit device authorization: %w", err)
	}
	return nil
}

func (s *Store) DeviceAuthorizationByUserCode(hash string, now time.Time) (*DeviceAuthorization, error) {
	row := s.db.QueryRow(`SELECT id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint,
		status, created_at, expires_at, approved_at, denied_at, last_poll_at, poll_interval_seconds, consumed_at
		FROM device_authorizations WHERE user_code_hash = ?`, hash)
	g, err := scanDeviceAuthorization(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGrantNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get device authorization: %w", err)
	}
	if !g.ExpiresAt.After(now) {
		return nil, ErrGrantExpired
	}
	return g, nil
}

func (s *Store) DeviceAuthorizationByDeviceCode(codeHash, secretHash string, now time.Time) (*DeviceAuthorization, error) {
	row := s.db.QueryRow(`SELECT id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint,
		status, created_at, expires_at, approved_at, denied_at, last_poll_at, poll_interval_seconds, consumed_at
		FROM device_authorizations WHERE device_code_hash = ? AND device_secret_hash = ?`, codeHash, secretHash)
	g, err := scanDeviceAuthorization(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrGrantNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get device authorization: %w", err)
	}
	if !g.ExpiresAt.After(now) {
		return nil, ErrGrantExpired
	}
	return g, nil
}

func (s *Store) DecideDeviceAuthorization(hash, decision string, now time.Time) error {
	if decision != "approved" && decision != "denied" {
		return errors.New("invalid device authorization decision")
	}
	column := "approved_at"
	if decision == "denied" {
		column = "denied_at"
	}
	res, err := s.db.Exec(`UPDATE device_authorizations SET status = ?, `+column+` = ?
		WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?`,
		decision, now.UTC().Format(rfc), hash, now.UTC().Format(rfc))
	if err != nil {
		return fmt.Errorf("decide device authorization: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrGrantNotFound
	}
	return nil
}

// PollDeviceAuthorization advances the persisted polling state. When the grant
// is approved it creates token and consumes the grant in the same transaction.
func (s *Store) PollDeviceAuthorization(codeHash, secretHash string, now time.Time, token APIToken) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin device poll: %w", err)
	}
	defer tx.Rollback()

	row := tx.QueryRow(`SELECT id, device_code_hash, device_secret_hash, user_code_hash, device_label, scopes, source_key, source_hint,
		status, created_at, expires_at, approved_at, denied_at, last_poll_at, poll_interval_seconds, consumed_at
		FROM device_authorizations WHERE device_code_hash = ? AND device_secret_hash = ?`, codeHash, secretHash)
	g, err := scanDeviceAuthorization(row)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrGrantNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("get device poll: %w", err)
	}
	if !g.ExpiresAt.After(now) {
		return 0, ErrGrantExpired
	}
	if g.Status == "denied" {
		return 0, ErrGrantDenied
	}
	if g.Status == "consumed" {
		return 0, ErrGrantConsumed
	}
	if g.Status == "approved" {
		_, err := tx.Exec(`INSERT INTO api_tokens
			(id, token_hash, display_prefix, device_label, scopes, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, token.ID, token.TokenHash, token.DisplayPrefix, token.DeviceLabel,
			token.Scopes, token.CreatedAt.UTC().Format(rfc), token.ExpiresAt.UTC().Format(rfc))
		if err != nil {
			return 0, fmt.Errorf("create api token: %w", err)
		}
		res, err := tx.Exec(`UPDATE device_authorizations SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'`, now.UTC().Format(rfc), g.ID)
		if err != nil {
			return 0, fmt.Errorf("consume device authorization: %w", err)
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return 0, ErrGrantConsumed
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("commit api token: %w", err)
		}
		return 0, nil
	}
	if g.LastPollAt != nil && now.Before(g.LastPollAt.Add(time.Duration(g.PollIntervalSeconds)*time.Second)) {
		interval := min(g.PollIntervalSeconds+5, 30)
		if _, err := tx.Exec(`UPDATE device_authorizations SET last_poll_at = ?, poll_interval_seconds = ? WHERE id = ?`, now.UTC().Format(rfc), interval, g.ID); err != nil {
			return 0, fmt.Errorf("slow device poll: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("commit slow device poll: %w", err)
		}
		return interval, ErrSlowDown
	}

	switch g.Status {
	case "pending":
		if _, err := tx.Exec(`UPDATE device_authorizations SET last_poll_at = ? WHERE id = ?`, now.UTC().Format(rfc), g.ID); err != nil {
			return 0, fmt.Errorf("record device poll: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("commit device poll: %w", err)
		}
		return g.PollIntervalSeconds, ErrGrantPending
	default:
		return 0, ErrGrantNotFound
	}
}

func (s *Store) APITokenByHash(hash string, now time.Time) (*APIToken, error) {
	row := s.db.QueryRow(`SELECT id, token_hash, display_prefix, device_label, scopes, created_at, expires_at, last_used_at, revoked_at
		FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, hash, now.UTC().Format(rfc))
	t, err := scanAPIToken(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get api token: %w", err)
	}
	return t, nil
}

func (s *Store) TouchAPIToken(id string, now time.Time) error {
	_, err := s.db.Exec(`UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
		now.UTC().Format(rfc), id, now.Add(-5*time.Minute).UTC().Format(rfc))
	return err
}

func (s *Store) RevokeAPIToken(id string, now time.Time) error {
	res, err := s.db.Exec(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now.UTC().Format(rfc), id)
	if err != nil {
		return fmt.Errorf("revoke api token: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListAPITokens() ([]APIToken, error) {
	rows, err := s.db.Query(`SELECT id, token_hash, display_prefix, device_label, scopes, created_at, expires_at, last_used_at, revoked_at
		FROM api_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	defer rows.Close()
	var out []APIToken
	for rows.Next() {
		t, err := scanAPIToken(rows)
		if err != nil {
			return nil, fmt.Errorf("scan api token: %w", err)
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

func (s *Store) CreateAdminSession(session AdminSession) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin admin session: %w", err)
	}
	defer tx.Rollback()
	now := session.CreatedAt.UTC().Format(rfc)
	if _, err := tx.Exec(`DELETE FROM admin_sessions WHERE expires_at <= ?`, now); err != nil {
		return fmt.Errorf("prune admin sessions: %w", err)
	}
	var active int
	if err := tx.QueryRow(`SELECT count(*) FROM admin_sessions`).Scan(&active); err != nil {
		return fmt.Errorf("count admin sessions: %w", err)
	}
	if active >= maxAdminSessions {
		return ErrSessionLimit
	}
	_, err = tx.Exec(`INSERT INTO admin_sessions (id, session_hash, authenticated, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		session.ID, session.SessionHash, boolToInt(session.Authenticated), session.CreatedAt.UTC().Format(rfc), session.ExpiresAt.UTC().Format(rfc))
	if err != nil {
		return fmt.Errorf("create admin session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit admin session: %w", err)
	}
	return nil
}

func (s *Store) AdminSessionByHash(hash string, now time.Time) (*AdminSession, error) {
	row := s.db.QueryRow(`SELECT id, session_hash, authenticated, created_at, expires_at FROM admin_sessions WHERE session_hash = ? AND expires_at > ?`, hash, now.UTC().Format(rfc))
	var session AdminSession
	var authenticated int
	var created, expires string
	if err := row.Scan(&session.ID, &session.SessionHash, &authenticated, &created, &expires); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, fmt.Errorf("get admin session: %w", err)
	}
	session.Authenticated = authenticated != 0
	createdAt, err := parseTime(created)
	if err != nil {
		return nil, fmt.Errorf("parse admin session created_at: %w", err)
	}
	expiresAt, err := parseTime(expires)
	if err != nil {
		return nil, fmt.Errorf("parse admin session expires_at: %w", err)
	}
	session.CreatedAt = createdAt
	session.ExpiresAt = expiresAt
	return &session, nil
}

func (s *Store) AuthenticateAdminSession(id string, expiresAt time.Time) error {
	_, err := s.db.Exec(`UPDATE admin_sessions SET authenticated = 1, expires_at = ? WHERE id = ?`, expiresAt.UTC().Format(rfc), id)
	return err
}

func (s *Store) DeleteAdminSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM admin_sessions WHERE id = ?`, id)
	return err
}

type scanner interface {
	Scan(...any) error
}

func scanDeviceAuthorization(row scanner) (*DeviceAuthorization, error) {
	var g DeviceAuthorization
	var created, expires string
	var approved, denied, lastPoll, consumed sql.NullString
	if err := row.Scan(&g.ID, &g.DeviceCodeHash, &g.DeviceSecretHash, &g.UserCodeHash, &g.DeviceLabel, &g.Scopes,
		&g.SourceKey, &g.SourceHint, &g.Status, &created, &expires, &approved, &denied, &lastPoll, &g.PollIntervalSeconds, &consumed); err != nil {
		return nil, err
	}
	var err error
	g.CreatedAt, err = parseTime(created)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization created_at: %w", err)
	}
	g.ExpiresAt, err = parseTime(expires)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization expires_at: %w", err)
	}
	g.ApprovedAt, err = parseNullTime(approved)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization approved_at: %w", err)
	}
	g.DeniedAt, err = parseNullTime(denied)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization denied_at: %w", err)
	}
	g.LastPollAt, err = parseNullTime(lastPoll)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization last_poll_at: %w", err)
	}
	g.ConsumedAt, err = parseNullTime(consumed)
	if err != nil {
		return nil, fmt.Errorf("parse device authorization consumed_at: %w", err)
	}
	return &g, nil
}

func scanAPIToken(row scanner) (*APIToken, error) {
	var token APIToken
	var created, expires string
	var lastUsed, revoked sql.NullString
	if err := row.Scan(&token.ID, &token.TokenHash, &token.DisplayPrefix, &token.DeviceLabel, &token.Scopes,
		&created, &expires, &lastUsed, &revoked); err != nil {
		return nil, err
	}
	var err error
	token.CreatedAt, err = parseTime(created)
	if err != nil {
		return nil, fmt.Errorf("parse api token created_at: %w", err)
	}
	token.ExpiresAt, err = parseTime(expires)
	if err != nil {
		return nil, fmt.Errorf("parse api token expires_at: %w", err)
	}
	token.LastUsedAt, err = parseNullTime(lastUsed)
	if err != nil {
		return nil, fmt.Errorf("parse api token last_used_at: %w", err)
	}
	token.RevokedAt, err = parseNullTime(revoked)
	if err != nil {
		return nil, fmt.Errorf("parse api token revoked_at: %w", err)
	}
	return &token, nil
}

func parseNullTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid {
		return nil, nil
	}
	t, err := parseTime(value.String)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
