// Command server runs the Columbia Pages HTTP service.
//
// Configuration (environment variables):
//
//	COLUMBIA_PAGES_PASSCODE  legacy shared secret for the JSON API
//	COLUMBIA_PAGES_ADMIN_PASSCODE owner secret for browser approval
//	COLUMBIA_PAGES_ALLOW_LEGACY_AUTH (default true)
//	COLUMBIA_PAGES_TOKEN_TTL_DAYS  (default 90, range 1..365)
//	DB_PATH                  SQLite file path        (default ./columbia-pages.db)
//	PORT                     listen port             (default 8080)
//	PUBLIC_BASE_URL          content origin, e.g. https://pages.example.com
//	CONTROL_BASE_URL         control origin; enables device authorization
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/davis7dotsh/columbia-pages/internal/store"
	"github.com/davis7dotsh/columbia-pages/internal/web"
)

func main() {
	dbPath := getenv("DB_PATH", "./columbia-pages.db")
	port := getenv("PORT", "8080")
	legacy, err := parseBoolEnv("COLUMBIA_PAGES_ALLOW_LEGACY_AUTH", true)
	if err != nil {
		log.Fatal(err)
	}
	tokenTTLDays, err := parseIntEnv("COLUMBIA_PAGES_TOKEN_TTL_DAYS", 90)
	if err != nil {
		log.Fatal(err)
	}
	passcode := os.Getenv("COLUMBIA_PAGES_PASSCODE")
	if legacy && passcode == "" {
		log.Fatal("COLUMBIA_PAGES_PASSCODE is required while COLUMBIA_PAGES_ALLOW_LEGACY_AUTH is true")
	}

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go sweepExpired(ctx, st, time.Hour)

	handler, err := web.NewConfigured(st, web.Config{
		Passcode: passcode, AdminPasscode: os.Getenv("COLUMBIA_PAGES_ADMIN_PASSCODE"),
		PublicBaseURL: os.Getenv("PUBLIC_BASE_URL"), ControlBaseURL: os.Getenv("CONTROL_BASE_URL"),
		AllowLegacyAuth: legacy, TokenTTLDays: tokenTTLDays,
	})
	if err != nil {
		log.Fatalf("configure server: %v", err)
	}
	if os.Getenv("CONTROL_BASE_URL") == "" {
		log.Print("device authorization disabled: CONTROL_BASE_URL is not configured")
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("columbia-pages listening on :%s (db=%s)", port, dbPath)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}

// sweepExpired periodically deletes expired pages until the context is cancelled.
func sweepExpired(ctx context.Context, st *store.Store, every time.Duration) {
	sweep := func() {
		if n, err := st.DeleteExpired(time.Now()); err != nil {
			log.Printf("expiry sweep: %v", err)
		} else if n > 0 {
			log.Printf("expiry sweep: removed %d page(s)", n)
		}
		if n, err := st.DeleteExpiredAuth(time.Now()); err != nil {
			log.Printf("auth expiry sweep: %v", err)
		} else if n > 0 {
			log.Printf("auth expiry sweep: removed %d record(s)", n)
		}
	}
	sweep() // run once at startup
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseBoolEnv(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return parsed, nil
}

func parseIntEnv(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return parsed, nil
}
