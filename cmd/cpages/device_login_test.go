package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveCredentialPrecedenceAndLegacyConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("COLUMBIA_PAGES_CONFIG_DIR", dir)
	if err := saveConfig(config{URL: "https://saved.example", Token: "saved-token", Passcode: "saved-passcode"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COLUMBIA_PAGES_PASSCODE", "env-passcode")
	t.Setenv("COLUMBIA_PAGES_TOKEN", "env-token")
	server, credential, kind, _, source, err := resolveCredential("")
	if err != nil {
		t.Fatal(err)
	}
	if server != "https://saved.example" || credential != "env-token" || kind != "device token" || source != "env" {
		t.Fatalf("resolveCredential() = %q, %q, %q, %q", server, credential, kind, source)
	}
	t.Setenv("COLUMBIA_PAGES_TOKEN", "")
	_, credential, kind, _, _, _ = resolveCredential("")
	if credential != "env-passcode" || kind != "legacy passcode" {
		t.Fatalf("passcode fallback = %q, %q", credential, kind)
	}

	legacyDir := t.TempDir()
	t.Setenv("COLUMBIA_PAGES_CONFIG_DIR", legacyDir)
	if err := os.WriteFile(filepath.Join(legacyDir, "config.json"), []byte(`{"url":"https://old.example","passcode":"old-secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COLUMBIA_PAGES_PASSCODE", "")
	_, credential, kind, _, _, err = resolveCredential("")
	if err != nil || credential != "old-secret" || kind != "legacy passcode" {
		t.Fatalf("legacy config = %q, %q, %v", credential, kind, err)
	}
}

func TestLoginWithDeviceAgainstHTTPServer(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("COLUMBIA_PAGES_CONFIG_DIR", dir)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/columbia-pages":
			json.NewEncoder(w).Encode(discoveryResponse{ControlURL: server.URL, ContentURL: server.URL, DeviceAuthorization: true})
		case "/api/auth/device/code":
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(deviceCodeResponse{DeviceCode: "device-code", UserCode: "ABCD-EFGH", VerificationURI: server.URL + "/activate", VerificationURIComplete: server.URL + "/activate?code=ABCD-EFGH", ExpiresIn: 30, Interval: 1})
		case "/api/auth/device/token":
			json.NewEncoder(w).Encode(map[string]any{"access_token": "cpages_test.secret", "token_type": "Bearer", "expires_in": 3600})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	if err := loginWithDevice(server.URL, "test device", false); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != server.URL || cfg.Token != "cpages_test.secret" || cfg.Passcode != "" {
		t.Fatalf("saved config = %#v", cfg)
	}
}

func TestNormalizeServerURLAcceptsLocalhostSubdomain(t *testing.T) {
	if _, err := normalizeServerURL("http://control.localhost:18080"); err != nil {
		t.Fatal(err)
	}
}

func TestRejectedCredentialMessageUsesCredentialTerminology(t *testing.T) {
	message, failure := rejectedCredentialMessage("device token")
	if message != "device token rejected, revoked, or expired" || failure != "device token authentication failed" {
		t.Fatalf("device token failure = %q, %q", message, failure)
	}
	message, failure = rejectedCredentialMessage("legacy passcode")
	if message != "legacy passcode rejected" || failure != "legacy passcode authentication failed" {
		t.Fatalf("legacy passcode failure = %q, %q", message, failure)
	}
}
