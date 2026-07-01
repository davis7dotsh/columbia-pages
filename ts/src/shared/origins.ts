import { Result } from "effect"

// Loopback rules match the Go implementation: localhost, *.localhost,
// 127.0.0.0/8 and [::1] may use plain HTTP; everything else must be HTTPS.
export const isLoopbackHost = (host: string): boolean => {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (lower === "localhost" || lower.endsWith(".localhost")) return true
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4 !== null) {
    // A dotted quad with an out-of-range octet (e.g. 127.1.1.999) is not an
    // IP address — it is a DNS name that could resolve anywhere, so it must
    // not qualify for the plain-HTTP loopback exception.
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    return octets.every((octet) => octet <= 255) && octets[0] === 127
  }
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1"
}

export interface ParsedOrigin {
  readonly origin: string
  readonly host: string
  readonly secure: boolean
}

// parseConfiguredOrigin validates a PUBLIC_BASE_URL / CONTROL_BASE_URL value
// and normalizes it to a scheme://host origin. Empty input is allowed here so
// the caller can produce its own "is required" error.
export const parseConfiguredOrigin = (
  value: string
): Result.Result<ParsedOrigin | null, string> => {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (trimmed === "") return Result.succeed(null)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return Result.fail("must be an absolute HTTP or HTTPS origin")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return Result.fail("must be an absolute HTTP or HTTPS origin")
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return Result.fail("must not contain credentials, a path, query, or fragment")
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return Result.fail("must use HTTPS outside loopback development")
  }
  // WHATWG URL already lowercases the hostname, keeps IPv6 brackets, and
  // drops default ports (80/443) from `port`.
  const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`
  return Result.succeed({
    origin: `${url.protocol}//${host}`,
    host,
    secure: url.protocol === "https:"
  })
}

// normalizeServerUrl validates a CLI --server value. Unlike
// parseConfiguredOrigin it returns the trimmed input (not a reconstructed
// origin) and rejects empty input.
export const normalizeServerUrl = (value: string): Result.Result<string, string> => {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (trimmed === "") return Result.fail("server URL is required")
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return Result.fail("server URL must be an absolute http:// or https:// URL")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return Result.fail("server URL must be an absolute http:// or https:// URL")
  }
  if (url.username !== "" || url.password !== "") {
    return Result.fail("server URL must not contain credentials")
  }
  if (url.search !== "" || url.hash !== "") {
    return Result.fail("server URL must not contain a query or fragment")
  }
  if (url.pathname !== "/") {
    return Result.fail("server URL must not contain a path")
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return Result.fail(
      "refusing to send credentials over plain HTTP; use HTTPS (HTTP is allowed for loopback development)"
    )
  }
  return Result.succeed(trimmed)
}
