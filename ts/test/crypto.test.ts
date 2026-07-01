import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  PAGE_ID_LENGTH,
  constantTimeSecretEqual,
  constantTimeStringEqual,
  hashHighEntropy,
  hashLowEntropy,
  newApiToken,
  newPageId,
  normalizeUserCode,
  randomBase64,
  randomUserCode
} from "../src/shared/crypto.ts"

describe("page ids", () => {
  test("are 12 base62 characters and unique", async () => {
    const ids = await Effect.runPromise(Effect.all(Array.from({ length: 200 }, () => newPageId)))
    for (const id of ids) {
      expect(id).toHaveLength(PAGE_ID_LENGTH)
      expect(id).toMatch(/^[0-9a-zA-Z]{12}$/)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("device authorization material", () => {
  test("user codes use the unambiguous alphabet", async () => {
    const code = await Effect.runPromise(randomUserCode)
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })

  test("api tokens are prefix.secret with a display prefix", async () => {
    const minted = await Effect.runPromise(newApiToken)
    expect(minted.displayPrefix).toBe(`cpages_${minted.id}`)
    expect(minted.token).toBe(`${minted.displayPrefix}.${minted.token.split(".")[1]}`)
    expect(minted.token.split(".")[1]!.length).toBeGreaterThanOrEqual(43)
  })

  test("randomBase64 produces url-safe unpadded output", async () => {
    const value = await Effect.runPromise(randomBase64(32))
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe("hashing", () => {
  test("hashHighEntropy is plain sha256 hex", () => {
    expect(hashHighEntropy("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  test("hashLowEntropy is keyed", () => {
    expect(hashLowEntropy("key-a", "value")).not.toBe(hashLowEntropy("key-b", "value"))
    expect(hashLowEntropy("key-a", "value")).toBe(hashLowEntropy("key-a", "value"))
  })

  test("constantTimeSecretEqual compares correctly", () => {
    expect(constantTimeSecretEqual("secret", "secret")).toBe(true)
    expect(constantTimeSecretEqual("secret", "other")).toBe(false)
  })

  test("constantTimeStringEqual compares correctly across lengths", () => {
    expect(constantTimeStringEqual("csrf-token", "csrf-token")).toBe(true)
    expect(constantTimeStringEqual("csrf-token", "csrf-other")).toBe(false)
    expect(constantTimeStringEqual("short", "longer-value")).toBe(false)
    expect(constantTimeStringEqual("", "")).toBe(true)
  })

  test("normalizeUserCode uppercases and strips dashes", () => {
    expect(normalizeUserCode(" abcd-efgh ")).toBe("ABCDEFGH")
  })
})
