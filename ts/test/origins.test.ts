import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { normalizeServerUrl, parseConfiguredOrigin } from "../src/shared/origins.ts"

const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${String(result)}`)
  return result.success
}

const err = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`expected failure, got ${String(result)}`)
  return result.failure
}

describe("normalizeServerUrl", () => {
  test("accepts https and trims trailing slashes", () => {
    expect(ok(normalizeServerUrl("https://pages.example.com/"))).toBe("https://pages.example.com")
  })

  test("accepts plain http only for loopback", () => {
    expect(ok(normalizeServerUrl("http://localhost:8080"))).toBe("http://localhost:8080")
    expect(ok(normalizeServerUrl("http://pages.localhost:8080"))).toBe(
      "http://pages.localhost:8080"
    )
    expect(ok(normalizeServerUrl("http://127.0.0.1:8080"))).toBe("http://127.0.0.1:8080")
    expect(err(normalizeServerUrl("http://pages.example.com"))).toContain(
      "refusing to send credentials over plain HTTP"
    )
  })

  test("rejects paths, queries, fragments, and credentials", () => {
    expect(err(normalizeServerUrl("https://example.com/api"))).toContain("path")
    expect(err(normalizeServerUrl("https://example.com?x=1"))).toContain("query")
    expect(err(normalizeServerUrl("https://example.com#frag"))).toContain("query or fragment")
    expect(err(normalizeServerUrl("https://user:pw@example.com"))).toContain("credentials")
    expect(err(normalizeServerUrl(""))).toContain("required")
    expect(err(normalizeServerUrl("not a url"))).toContain("absolute")
  })
})

describe("parseConfiguredOrigin", () => {
  test("empty input is allowed and yields null", () => {
    expect(ok(parseConfiguredOrigin(""))).toBeNull()
  })

  test("normalizes to a scheme://host origin", () => {
    const parsed = ok(parseConfiguredOrigin("https://Pages.Example.com/"))
    expect(parsed).toEqual({ origin: "https://pages.example.com", host: "pages.example.com", secure: true })
  })

  test("strips default ports", () => {
    expect(ok(parseConfiguredOrigin("https://example.com:443"))?.host).toBe("example.com")
    expect(ok(parseConfiguredOrigin("http://localhost:80"))?.host).toBe("localhost")
  })

  test("keeps explicit non-default ports", () => {
    expect(ok(parseConfiguredOrigin("http://control.localhost:8080"))).toEqual({
      origin: "http://control.localhost:8080",
      host: "control.localhost:8080",
      secure: false
    })
  })

  test("requires HTTPS outside loopback", () => {
    expect(err(parseConfiguredOrigin("http://example.com"))).toContain("HTTPS")
  })

  test("rejects credentials, paths, queries, and fragments", () => {
    expect(err(parseConfiguredOrigin("https://example.com/path"))).toContain("path")
    expect(err(parseConfiguredOrigin("https://u:p@example.com"))).toContain("credentials")
  })
})
