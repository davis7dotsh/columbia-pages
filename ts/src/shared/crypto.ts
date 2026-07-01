import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
export const PAGE_ID_LENGTH = 12 // 62^12 ≈ 71 bits — unguessable

// newPageId returns a URL-safe, unguessable base62 identifier. It uses
// rejection sampling so every character is uniformly distributed.
export const newPageId: Effect.Effect<string> = Effect.sync(() => {
  let out = ""
  while (out.length < PAGE_ID_LENGTH) {
    for (const byte of randomBytes(PAGE_ID_LENGTH)) {
      // 62*4 = 248; reject the top 8 values to keep the distribution uniform.
      if (byte >= 248 || out.length >= PAGE_ID_LENGTH) continue
      out += ID_ALPHABET[byte % 62]
    }
  }
  return out
})

export const randomBase64 = (size: number): Effect.Effect<string> =>
  Effect.sync(() => randomBytes(size).toString("base64url"))

// randomUserCode returns an owner-facing code like "ABCD-EFGH". The 32-char
// alphabet divides 256 evenly, so plain modulo is unbiased.
export const randomUserCode: Effect.Effect<string> = Effect.sync(() => {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  let code = ""
  for (const byte of randomBytes(8)) code += alphabet[byte % 32]
  return `${code.slice(0, 4)}-${code.slice(4)}`
})

export interface NewApiToken {
  readonly token: string
  readonly id: string
  readonly displayPrefix: string
}

export const newApiToken: Effect.Effect<NewApiToken> = Effect.gen(function* () {
  const id = yield* randomBase64(9)
  const secret = yield* randomBase64(32)
  const displayPrefix = `cpages_${id}`
  return { token: `${displayPrefix}.${secret}`, id, displayPrefix }
})

// hashHighEntropy hashes device codes and API tokens for at-rest storage.
export const hashHighEntropy = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

// hashLowEntropy keys guessable values (user codes, session cookies, request
// sources) with the admin passcode so the database alone cannot verify them.
export const hashLowEntropy = (key: string, value: string): string =>
  createHmac("sha256", key).update(value).digest("hex")

export const constantTimeSecretEqual = (left: string, right: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest()
  )

export const constantTimeStringEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const normalizeUserCode = (value: string): string =>
  value.trim().replaceAll("-", "").toUpperCase()
