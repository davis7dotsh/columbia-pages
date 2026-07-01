import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface CliConfig {
  readonly url: string
  readonly token: string
}

/**
 * configDir resolves the directory holding config.json:
 *   $COLUMBIA_PAGES_CONFIG_DIR, else $XDG_CONFIG_HOME/columbia-pages,
 *   else ~/.config/columbia-pages
 */
export const configDir = (): string => {
  const explicit = process.env["COLUMBIA_PAGES_CONFIG_DIR"]
  if (explicit) return explicit
  const xdg = process.env["XDG_CONFIG_HOME"]
  if (xdg) return path.join(xdg, "columbia-pages")
  return path.join(os.homedir() || ".", ".config", "columbia-pages")
}

export const configPath = (): string => path.join(configDir(), "config.json")

/** loadConfig reads the saved login; a missing file yields empty fields. */
export const loadConfig = (): CliConfig => {
  let data: string
  try {
    data = fs.readFileSync(configPath(), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { url: "", token: "" }
    throw e
  }
  const parsed = JSON.parse(data) as { url?: string; token?: string }
  return { url: parsed.url ?? "", token: parsed.token ?? "" }
}

/** saveConfig writes the config with restrictive permissions (it holds a secret). */
export const saveConfig = (c: CliConfig): void => {
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const body: Record<string, string> = { url: c.url }
  if (c.token !== "") body.token = c.token
  fs.writeFileSync(configPath(), JSON.stringify(body, null, 2) + "\n", { mode: 0o600 })
  fs.chmodSync(configPath(), 0o600)
}

export const removeConfig = (): boolean => {
  try {
    fs.unlinkSync(configPath())
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
    throw e
  }
}

export interface Resolved {
  readonly server: string
  readonly token: string
  readonly serverSrc: string
  readonly tokenSrc: string
}

/**
 * resolve applies flag/env/config precedence for the server and env/config
 * precedence for the device token.
 */
export const resolve = (serverFlag: string): Resolved => {
  const cfg = loadConfig()
  let server = ""
  let serverSrc = ""
  if (serverFlag.trim() !== "") {
    server = serverFlag
    serverSrc = "flag"
  } else if ((process.env["COLUMBIA_PAGES_URL"] ?? "") !== "") {
    server = process.env["COLUMBIA_PAGES_URL"]!
    serverSrc = "env"
  } else if (cfg.url !== "") {
    server = cfg.url
    serverSrc = "config"
  }

  let token = ""
  let tokenSrc = ""
  if ((process.env["COLUMBIA_PAGES_TOKEN"] ?? "") !== "") {
    token = process.env["COLUMBIA_PAGES_TOKEN"]!
    tokenSrc = "env"
  } else if (cfg.token !== "") {
    token = cfg.token
    tokenSrc = "config"
  }

  return {
    server: server.trim().replace(/\/+$/, ""),
    token: token.trim(),
    serverSrc,
    tokenSrc,
  }
}
