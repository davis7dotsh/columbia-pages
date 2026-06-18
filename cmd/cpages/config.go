package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"
)

// config is the persisted CLI login: the server to talk to and the passcode.
type config struct {
	URL      string `json:"url"`
	Passcode string `json:"passcode"`
}

// configDir resolves the directory holding config.json:
//
//	$COLUMBIA_PAGES_CONFIG_DIR, else $XDG_CONFIG_HOME/columbia-pages,
//	else ~/.config/columbia-pages
func configDir() string {
	if d := os.Getenv("COLUMBIA_PAGES_CONFIG_DIR"); d != "" {
		return d
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "columbia-pages")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".config", "columbia-pages")
}

func configPath() string { return filepath.Join(configDir(), "config.json") }

// loadConfig reads the saved config. A missing file yields a zero config and
// no error, so callers can treat "not logged in" as empty fields.
func loadConfig() (config, error) {
	var c config
	data, err := os.ReadFile(configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return c, err
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("parse %s: %w", configPath(), err)
	}
	return c, nil
}

// saveConfig writes the config with restrictive permissions (it holds a secret).
func saveConfig(c config) error {
	dir := configDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("secure %s: %w", dir, err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	f, err := os.OpenFile(configPath(), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", configPath(), err)
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return fmt.Errorf("secure %s: %w", configPath(), err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", configPath(), err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("write %s: %w", configPath(), err)
	}
	return nil
}

// resolve determines the effective server and passcode and where each came
// from. The server precedence is flag, environment, then saved config; the
// passcode precedence is environment, then saved config.
func resolve(serverFlag string) (server, passcode, serverSrc, passcodeSrc string, err error) {
	cfg, err := loadConfig()
	if err != nil {
		return "", "", "", "", err
	}

	switch {
	case strings.TrimSpace(serverFlag) != "":
		server, serverSrc = serverFlag, "flag"
	case os.Getenv("COLUMBIA_PAGES_URL") != "":
		server, serverSrc = os.Getenv("COLUMBIA_PAGES_URL"), "env"
	case cfg.URL != "":
		server, serverSrc = cfg.URL, "config"
	}

	switch {
	case os.Getenv("COLUMBIA_PAGES_PASSCODE") != "":
		passcode, passcodeSrc = os.Getenv("COLUMBIA_PAGES_PASSCODE"), "env"
	case cfg.Passcode != "":
		passcode, passcodeSrc = cfg.Passcode, "config"
	}

	return strings.TrimRight(strings.TrimSpace(server), "/"), strings.TrimSpace(passcode), serverSrc, passcodeSrc, nil
}

// readLine prompts on stderr and reads one visible line from stdin.
func readLine(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// readSecret prompts on stderr and reads a passcode without echoing it when
// stdin is a terminal; otherwise it reads a piped line (for scripting).
func readSecret(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}
