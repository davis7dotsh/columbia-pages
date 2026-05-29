// Package web implements the Columbia Pages HTTP server: a small JSON API
// (passcode-protected) for managing pages, and public, unguessable view URLs.
package web

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"html"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"columbia-pages/internal/store"
	"columbia-pages/theme"
)

const maxBodyBytes = 8 << 20 // 8 MiB cap on uploaded HTML

// Server is the HTTP handler for Columbia Pages.
type Server struct {
	store    *store.Store
	passcode string
	baseURL  string // PUBLIC_BASE_URL; if empty, derived from each request
	mux      *http.ServeMux
}

// New builds a Server with all routes registered.
func New(st *store.Store, passcode, baseURL string) *Server {
	s := &Server{store: st, passcode: passcode, baseURL: strings.TrimRight(baseURL, "/")}
	mux := http.NewServeMux()

	// Public.
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /theme.css", s.handleThemeCSS)
	mux.HandleFunc("GET /p/{id}", s.handleServePage)
	mux.HandleFunc("GET /{$}", s.handleIndex)

	// Authenticated JSON API.
	mux.HandleFunc("GET /api/auth", s.auth(s.handleAuthCheck))
	mux.HandleFunc("POST /api/pages", s.auth(s.handleCreate))
	mux.HandleFunc("GET /api/pages", s.auth(s.handleList))
	mux.HandleFunc("GET /api/pages/{id}", s.auth(s.handleGetMeta))
	mux.HandleFunc("PUT /api/pages/{id}", s.auth(s.handleUpdate))
	mux.HandleFunc("DELETE /api/pages/{id}", s.auth(s.handleDelete))

	s.mux = mux
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec := &statusRecorder{ResponseWriter: w, status: 200}
	start := time.Now()
	s.mux.ServeHTTP(rec, r)
	log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
}

// --- public handlers -------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	io.WriteString(w, "ok")
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, "Columbia Pages\n")
}

// handleAuthCheck returns 200 when the passcode is valid; it lets `cpages login`
// verify credentials. (Reaching this handler at all means auth() passed.)
func (s *Server) handleAuthCheck(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleThemeCSS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	io.WriteString(w, theme.CSS)
}

func (s *Server) handleServePage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, err := s.store.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if p.ExpiresAt != nil && !p.ExpiresAt.After(time.Now()) {
		http.NotFound(w, r) // expired
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if p.Raw {
		io.WriteString(w, p.HTML)
		return
	}
	io.WriteString(w, renderThemed(p.Title, p.HTML))
}

// renderThemed wraps body content in a full HTML document that links the house
// stylesheet. The agent only writes the content that lives inside .page.
func renderThemed(title, content string) string {
	var b strings.Builder
	b.WriteString("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<title>")
	b.WriteString(html.EscapeString(title))
	b.WriteString("</title>\n")
	b.WriteString("<link rel=\"stylesheet\" href=\"/theme.css\">\n")
	b.WriteString("</head>\n<body>\n<main class=\"page\">\n")
	b.WriteString(content)
	b.WriteString("\n</main>\n</body>\n</html>\n")
	return b.String()
}

// --- API: requests & responses ---------------------------------------------

type createReq struct {
	Title   string `json:"title"`
	Slug    string `json:"slug,omitempty"`
	HTML    string `json:"html"`
	Raw     bool   `json:"raw,omitempty"`
	TTLDays int    `json:"ttl_days,omitempty"`
}

type updateReq struct {
	Title   *string `json:"title,omitempty"`
	Slug    *string `json:"slug,omitempty"`
	HTML    *string `json:"html,omitempty"`
	Raw     *bool   `json:"raw,omitempty"`
	TTLDays *int    `json:"ttl_days,omitempty"` // >0 sets expiry; <=0 clears it
}

type pageResp struct {
	ID        string     `json:"id"`
	URL       string     `json:"url"`
	Title     string     `json:"title"`
	Slug      string     `json:"slug,omitempty"`
	Raw       bool       `json:"raw"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Size      int        `json:"size,omitempty"`
}

// --- API handlers ----------------------------------------------------------

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createReq
	if !s.decode(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		s.writeErr(w, http.StatusBadRequest, "title is required")
		return
	}
	if strings.TrimSpace(req.HTML) == "" {
		s.writeErr(w, http.StatusBadRequest, "html is required")
		return
	}

	now := time.Now().UTC()
	p := &store.Page{
		Title:     req.Title,
		Slug:      strings.TrimSpace(req.Slug),
		HTML:      req.HTML,
		Raw:       req.Raw,
		CreatedAt: now,
		UpdatedAt: now,
		ExpiresAt: ttlToExpiry(now, req.TTLDays),
	}

	// Generate a unique id (collisions are astronomically unlikely; retry anyway).
	var createErr error
	for attempt := 0; attempt < 5; attempt++ {
		id, err := newID()
		if err != nil {
			s.writeErr(w, http.StatusInternalServerError, "could not generate id")
			return
		}
		p.ID = id
		if createErr = s.store.Create(p); createErr == nil {
			break
		}
	}
	if createErr != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not save page")
		return
	}

	s.writeJSON(w, http.StatusCreated, s.toResp(r, p, len(p.HTML)))
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			limit = n
		}
	}
	metas, err := s.store.List(limit)
	if err != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not list pages")
		return
	}
	out := make([]pageResp, 0, len(metas))
	for _, m := range metas {
		out = append(out, pageResp{
			ID:        m.ID,
			URL:       s.pageURL(r, m.ID),
			Title:     m.Title,
			Slug:      m.Slug,
			Raw:       m.Raw,
			CreatedAt: m.CreatedAt,
			UpdatedAt: m.UpdatedAt,
			ExpiresAt: m.ExpiresAt,
			Size:      m.Size,
		})
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"pages": out})
}

func (s *Server) handleGetMeta(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.Get(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeErr(w, http.StatusNotFound, "page not found")
		return
	}
	if err != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not load page")
		return
	}
	s.writeJSON(w, http.StatusOK, s.toResp(r, p, len(p.HTML)))
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var req updateReq
	if !s.decode(w, r, &req) {
		return
	}
	p, err := s.store.Get(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeErr(w, http.StatusNotFound, "page not found")
		return
	}
	if err != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not load page")
		return
	}

	if req.Title != nil {
		t := strings.TrimSpace(*req.Title)
		if t == "" {
			s.writeErr(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		p.Title = t
	}
	if req.Slug != nil {
		p.Slug = strings.TrimSpace(*req.Slug)
	}
	if req.HTML != nil {
		if strings.TrimSpace(*req.HTML) == "" {
			s.writeErr(w, http.StatusBadRequest, "html cannot be empty")
			return
		}
		p.HTML = *req.HTML
	}
	if req.Raw != nil {
		p.Raw = *req.Raw
	}
	if req.TTLDays != nil {
		p.ExpiresAt = ttlToExpiry(time.Now().UTC(), *req.TTLDays)
	}
	p.UpdatedAt = time.Now().UTC()

	if err := s.store.Save(p); err != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not save page")
		return
	}
	s.writeJSON(w, http.StatusOK, s.toResp(r, p, len(p.HTML)))
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.store.Delete(id)
	if errors.Is(err, store.ErrNotFound) {
		s.writeErr(w, http.StatusNotFound, "page not found")
		return
	}
	if err != nil {
		s.writeErr(w, http.StatusInternalServerError, "could not delete page")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
}

// --- helpers ---------------------------------------------------------------

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(bearerToken(r)), []byte(s.passcode)) != 1 {
			s.writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	// Fallback: allow a plain header for convenience.
	return strings.TrimSpace(r.Header.Get("X-Passcode"))
}

func (s *Server) decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		s.writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func (s *Server) toResp(r *http.Request, p *store.Page, size int) pageResp {
	return pageResp{
		ID:        p.ID,
		URL:       s.pageURL(r, p.ID),
		Title:     p.Title,
		Slug:      p.Slug,
		Raw:       p.Raw,
		CreatedAt: p.CreatedAt,
		UpdatedAt: p.UpdatedAt,
		ExpiresAt: p.ExpiresAt,
		Size:      size,
	}
}

func (s *Server) pageURL(r *http.Request, id string) string {
	base := s.baseURL
	if base == "" {
		proto := r.Header.Get("X-Forwarded-Proto")
		if proto == "" {
			if r.TLS != nil {
				proto = "https"
			} else {
				proto = "http"
			}
		}
		base = proto + "://" + r.Host
	}
	return base + "/p/" + id
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func (s *Server) writeErr(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]string{"error": msg})
}

// ttlToExpiry converts a TTL in days to an absolute expiry, or nil if days <= 0.
func ttlToExpiry(now time.Time, days int) *time.Time {
	if days <= 0 {
		return nil
	}
	t := now.Add(time.Duration(days) * 24 * time.Hour)
	return &t
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
