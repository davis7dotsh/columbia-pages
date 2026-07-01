import { Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as net from "node:net"
import { hashLowEntropy } from "../internal/crypto.ts"
import type { ServerConfigShape } from "./Config.ts"

export const json = (status: number, value: unknown): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(JSON.stringify(value), {
    status,
    contentType: "application/json; charset=utf-8",
  })

export const errJson = (status: number, msg: string): HttpServerResponse.HttpServerResponse =>
  json(status, { error: msg })

export const bearerToken = (req: HttpServerRequest): string => {
  const h = req.headers["authorization"] ?? ""
  if (h.startsWith("Bearer ")) return h.slice("Bearer ".length).trim()
  return ""
}

export const hostOf = (req: HttpServerRequest): string => req.headers["host"] ?? ""

export const remoteAddressOf = (req: HttpServerRequest): string =>
  Option.getOrElse(req.remoteAddress, () => "")

// --- scopes ----------------------------------------------------------------

export const validateScopes = (input: ReadonlyArray<string>): readonly [ReadonlyArray<string>, boolean] => {
  if (input.length === 0) return [["pages:read", "pages:write"], true]
  const seen = new Set<string>()
  for (const scope of input) {
    if (scope !== "pages:read" && scope !== "pages:write") return [[], false]
    seen.add(scope)
  }
  if (!seen.has("pages:read")) return [[], false]
  const out = ["pages:read"]
  if (seen.has("pages:write")) out.push("pages:write")
  return [out, true]
}

export const hasScope = (scopes: ReadonlyArray<string>, want: string): boolean => scopes.includes(want)

export const splitScopes = (value: string): ReadonlyArray<string> => value.split(/\s+/).filter((s) => s !== "")

// --- request source (rate-limit keying + display hint) ---------------------

const isLoopbackIP = (host: string): boolean => {
  const v = net.isIP(host)
  if (v === 4) return host.startsWith("127.")
  if (v === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1"
  return false
}

/**
 * stripPort removes a trailing ":port" from a remote address without garbling
 * bare IPv6 literals (e.g. "::1"), which contain several colons and no port.
 */
const stripPort = (addr: string): string => {
  if (addr.startsWith("[")) {
    const end = addr.indexOf("]")
    return end > 0 ? addr.slice(1, end) : addr.slice(1)
  }
  const first = addr.indexOf(":")
  // Exactly one colon means "host:port"; multiple colons means a bare IPv6.
  if (first >= 0 && first === addr.lastIndexOf(":")) return addr.slice(0, first)
  return addr
}

export const requestSource = (
  req: HttpServerRequest,
  config: ServerConfigShape,
): readonly [string, string] => {
  let host = ""
  if (config.trustForwardedIP) {
    const forwarded = (req.headers["x-real-ip"] ?? "").trim()
    if (net.isIP(forwarded) !== 0) host = forwarded
  }
  if (host === "") {
    // remoteAddress may be "ip:port", "[ipv6]:port", "[ipv6]", or a bare address.
    host = stripPort(remoteAddressOf(req).trim())
  }
  if (host === "") host = "unknown"
  let hint = host
  const v = net.isIP(host)
  if (v !== 0 && !isLoopbackIP(host)) {
    if (v === 4) {
      const parts = host.split(".")
      hint = `${parts[0]}.${parts[1]}.${parts[2]}.x`
    } else {
      hint = "IPv6 address"
    }
  }
  return [hashLowEntropy(config.adminPasscode, host), hint]
}

// --- logging ---------------------------------------------------------------

export const logPath = (path: string): string => {
  if (path.startsWith("/p/")) return "/p/[redacted]"
  if (path.startsWith("/api/pages/")) return "/api/pages/[redacted]"
  return path
}
