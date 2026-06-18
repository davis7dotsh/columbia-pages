package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/davis7dotsh/columbia-pages/internal/store"
)

func TestCreateAndServeThemedPage(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "pages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	ts := httptest.NewServer(New(st, "test-passcode", "https://pages.example.com"))
	t.Cleanup(ts.Close)

	body := `{"title":"Status <check>","html":"<script>window.demo=true</script><p>Hello</p>"}`
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/pages", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-passcode")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(resp.Body)
		t.Fatalf("create status = %d, body = %s", resp.StatusCode, data)
	}
	var created struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.URL != "https://pages.example.com/p/"+created.ID {
		t.Fatalf("created URL = %q", created.URL)
	}

	pageResp, err := http.Get(ts.URL + "/p/" + created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer pageResp.Body.Close()
	page, err := io.ReadAll(pageResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(page, []byte("<title>Status &lt;check&gt;</title>")) {
		t.Fatalf("title was not escaped: %s", page)
	}
	if !bytes.Contains(page, []byte("<script>window.demo=true</script>")) {
		t.Fatalf("publisher HTML contract changed: %s", page)
	}
	credit := `<footer class="columbia-pages-credit">
<a href="https://github.com/davis7dotsh/columbia-pages" target="_blank" rel="noopener noreferrer">generated on Columbia Pages</a>
</footer>`
	if !bytes.Contains(page, []byte(credit)) {
		t.Fatalf("generated credit is missing or unsafe: %s", page)
	}
	if bytes.Index(page, []byte(credit)) < bytes.Index(page, []byte("<script>window.demo=true</script>")) {
		t.Fatalf("generated credit appeared before publisher content: %s", page)
	}
	if got := pageResp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", got)
	}
	if got := pageResp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

func TestAPIRejectsMissingAndLegacyHeaders(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "pages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	h := New(st, "test-passcode", "https://pages.example.com")
	for _, header := range []string{"", "X-Passcode"} {
		t.Run(header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/auth", nil)
			if header != "" {
				req.Header.Set(header, "test-passcode")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
			}
		})
	}
}

func TestEmptyServerPasscodeFailsClosed(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "pages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	req := httptest.NewRequest(http.MethodGet, "/api/auth", nil)
	req.Header.Set("Authorization", "Bearer ")
	rec := httptest.NewRecorder()
	New(st, "", "https://pages.example.com").ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestLogPathRedactsPublicPageIDs(t *testing.T) {
	for input, want := range map[string]string{
		"/p/secret-page-id":         "/p/[redacted]",
		"/api/pages/secret-page-id": "/api/pages/[redacted]",
		"/api/pages":                "/api/pages",
	} {
		if got := logPath(input); got != want {
			t.Errorf("logPath(%q) = %q, want %q", input, got, want)
		}
	}
}
