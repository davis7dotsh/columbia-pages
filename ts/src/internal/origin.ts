import * as net from "node:net"

export const isLoopbackHostname = (host: string): boolean => {
  host = host.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return true
  const version = net.isIP(host)
  if (version === 0) return false
  // Loopback: 127.0.0.0/8 or ::1
  if (version === 4) return host.startsWith("127.")
  return host === "::1" || host === "0:0:0:0:0:0:0:1"
}

export interface ParsedOrigin {
  readonly origin: string
  readonly host: string
  readonly secure: boolean
}

/**
 * parseConfiguredOrigin validates a control/content origin and returns its
 * canonical origin string, host (with non-default port), and https flag.
 */
export const parseConfiguredOrigin = (value: string): ParsedOrigin => {
  value = value.trim().replace(/\/+$/, "")
  if (value === "") return { origin: "", host: "", secure: false }

  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error("must be an absolute HTTP or HTTPS origin")
  }
  if (u.hostname === "" || (u.protocol !== "http:" && u.protocol !== "https:")) {
    throw new Error("must be an absolute HTTP or HTTPS origin")
  }
  if (u.username !== "" || u.password !== "" || (u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") {
    throw new Error("must not contain credentials, a path, query, or fragment")
  }
  const scheme = u.protocol === "https:" ? "https" : "http"
  if (scheme === "http" && !isLoopbackHostname(u.hostname)) {
    throw new Error("must use HTTPS outside loopback development")
  }
  const hostname = u.hostname.toLowerCase()
  let port = u.port
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) {
    port = ""
  }
  let host = hostname
  if (port !== "") {
    host = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`
  } else if (hostname.includes(":")) {
    host = `[${hostname}]`
  }
  return { origin: `${scheme}://${host}`, host, secure: scheme === "https" }
}

/** normalizeServerURL validates a CLI --server URL and returns it trimmed. */
export const normalizeServerURL = (value: string): string => {
  value = value.trim().replace(/\/+$/, "")
  if (value === "") throw new Error("server URL is required")
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error("server URL must be an absolute http:// or https:// URL")
  }
  if (u.hostname === "" || (u.protocol !== "http:" && u.protocol !== "https:")) {
    throw new Error("server URL must be an absolute http:// or https:// URL")
  }
  if (u.username !== "" || u.password !== "") throw new Error("server URL must not contain credentials")
  if (u.search !== "" || u.hash !== "") throw new Error("server URL must not contain a query or fragment")
  if (u.pathname !== "" && u.pathname !== "/") throw new Error("server URL must not contain a path")
  const scheme = u.protocol === "https:" ? "https" : "http"
  if (scheme === "http" && !isLoopbackHostname(u.hostname)) {
    throw new Error("refusing to send credentials over plain HTTP; use HTTPS (HTTP is allowed for loopback development)")
  }
  return value
}
