import { Effect, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { hashLowEntropy } from "../shared/crypto.ts"
import type { ServerConfigShape } from "./config.ts"

export const jsonResponse = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    contentType: "application/json; charset=utf-8"
  })

export const errResponse = (status: number, message: string) =>
  jsonResponse(status, { error: message })

export const notFoundText = HttpServerResponse.text("404 page not found\n", {
  status: 404,
  contentType: "text/plain; charset=utf-8"
})

export const bearerToken = (request: HttpServerRequest.HttpServerRequest): string => {
  const header = request.headers["authorization"] ?? ""
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
}

export const requestPath = (request: HttpServerRequest.HttpServerRequest): string => {
  const url = request.url
  const q = url.indexOf("?")
  return q === -1 ? url : url.slice(0, q)
}

export const isControlHost = (
  config: ServerConfigShape,
  request: HttpServerRequest.HttpServerRequest
): boolean => (request.headers["host"] ?? "").toLowerCase() === config.controlHost

// requestSource identifies the calling network source for rate limiting: a
// keyed hash for storage plus a coarse human-readable hint for the owner.
export const requestSource = (
  config: ServerConfigShape
): Effect.Effect<
  { readonly sourceKey: string; readonly sourceHint: string },
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    let host = ""
    if (config.trustForwardedIp) {
      const forwarded = (request.headers["x-real-ip"] ?? "").trim()
      if (isIpAddress(forwarded)) host = forwarded
    }
    if (host === "") {
      const remote = request.remoteAddress
      host = remote._tag === "Some" ? stripPort(remote.value) : ""
    }
    if (host === "") host = "unknown"
    let hint = host
    const v4 = parseIpv4(host)
    if (v4 !== null && v4[0] !== 127) {
      hint = `${v4[0]}.${v4[1]}.${v4[2]}.x`
    } else if (v4 === null && host.includes(":") && host !== "unknown") {
      if (!isLoopbackIpv6(host)) hint = "IPv6 address"
    }
    return {
      sourceKey: hashLowEntropy(Redacted.value(config.adminPasscode), host),
      sourceHint: hint
    }
  })

const parseIpv4 = (value: string): [number, number, number, number] | null => {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (match === null) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  if (parts.some((p) => p > 255)) return null
  return parts as [number, number, number, number]
}

const isLoopbackIpv6 = (value: string): boolean => {
  const bare = value.replace(/^\[|\]$/g, "")
  return bare === "::1" || bare === "0:0:0:0:0:0:0:1"
}

const isIpAddress = (value: string): boolean =>
  parseIpv4(value) !== null || (value.includes(":") && /^[0-9a-fA-F:.[\]]+$/.test(value))

const stripPort = (value: string): string => {
  const v4WithPort = value.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/)
  if (v4WithPort !== null) return v4WithPort[1]!
  const v6WithPort = value.match(/^\[(.+)\]:\d+$/)
  if (v6WithPort !== null) return v6WithPort[1]!
  return value
}
