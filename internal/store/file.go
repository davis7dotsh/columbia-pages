package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// File is an uploaded binary object served from an unguessable public URL.
type File struct {
	ID          string
	Name        string
	ContentType string
	Data        []byte
	CreatedAt   time.Time
	ExpiresAt   *time.Time
}

// CreateFile inserts an uploaded file.
func (s *Store) CreateFile(f *File) error {
	_, err := s.db.Exec(
		`INSERT INTO files (id, name, content_type, data, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		f.ID, f.Name, f.ContentType, f.Data, f.CreatedAt.UTC().Format(rfc), nullTime(f.ExpiresAt),
	)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	return nil
}

// GetFile returns an uploaded file regardless of expiry.
func (s *Store) GetFile(id string) (*File, error) {
	row := s.db.QueryRow(
		`SELECT id, name, content_type, data, created_at, expires_at FROM files WHERE id = ?`, id)
	var f File
	var created string
	var expires sql.NullString
	switch err := row.Scan(&f.ID, &f.Name, &f.ContentType, &f.Data, &created, &expires); {
	case errors.Is(err, sql.ErrNoRows):
		return nil, ErrNotFound
	case err != nil:
		return nil, fmt.Errorf("get file: %w", err)
	}
	if t, err := parseTime(created); err == nil {
		f.CreatedAt = t
	}
	if expires.Valid {
		if t, err := parseTime(expires.String); err == nil {
			f.ExpiresAt = &t
		}
	}
	return &f, nil
}

// DeleteFile removes an uploaded file.
func (s *Store) DeleteFile(id string) error {
	res, err := s.db.Exec(`DELETE FROM files WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete file: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
