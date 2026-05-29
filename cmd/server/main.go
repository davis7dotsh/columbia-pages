// Command server runs the Columbia Pages HTTP service.
//
// Configuration (environment variables):
//
//	COLUMBIA_PAGES_PASSCODE  (required) shared secret for the JSON API
//	DB_PATH                  SQLite file path        (default ./columbia-pages.db)
//	PORT                     listen port             (default 8080)
//	PUBLIC_BASE_URL          e.g. https://pages.example.com (default: derived from request)
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/davis7dotsh/columbia-pages/internal/store"
	"github.com/davis7dotsh/columbia-pages/internal/web"
)

func main() {
	passcode := os.Getenv("COLUMBIA_PAGES_PASSCODE")
	if passcode == "" {
		log.Fatal("COLUMBIA_PAGES_PASSCODE is required")
	}
	dbPath := getenv("DB_PATH", "./columbia-pages.db")
	port := getenv("PORT", "8080")
	baseURL := os.Getenv("PUBLIC_BASE_URL")

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go sweepExpired(ctx, st, time.Hour)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           web.New(st, passcode, baseURL),
		ReadHeaderTimeout: 10 * time.Second,
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
