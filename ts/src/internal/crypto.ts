import * as crypto from "node:crypto"

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
const idLen = 12 // 62^12 ~= 71 bits — unguessable

/**
 * newID returns a URL-safe, unguessable base62 identifier. It uses rejection
 * sampling so every character is uniformly distributed (no modulo bias).
 */
export const newID = (): string => {
  const out = Buffer.alloc(idLen)
  const buf = Buffer.alloc(1)
  let i = 0
  while (i < idLen) {
    crypto.randomFillSync(buf)
    // 62*4 = 248; reject the top 8 values to keep the distribution uniform.
    if (buf[0]! >= 248) continue
    out[i] = alphabet.charCodeAt(buf[0]! % 62)
    i++
  }
  return out.toString("latin1")
}

/** randomBase64 returns `size` random bytes encoded as unpadded base64url. */
export const randomBase64 = (size: number): string =>
  crypto.randomBytes(size).toString("base64url")

const userCodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

/** randomUserCode returns an 8-char, hyphenated, human-friendly code. */
export const randomUserCode = (): string => {
  const random = crypto.randomBytes(8)
  const b = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    b[i] = userCodeAlphabet.charCodeAt(random[i]! % userCodeAlphabet.length)
  }
  const s = b.toString("latin1")
  return s.slice(0, 4) + "-" + s.slice(4)
}

/** newAPIToken returns [rawToken, id, displayPrefix]. */
export const newAPIToken = (): readonly [string, string, string] => {
  const id = randomBase64(9)
  const secret = randomBase64(32)
  const prefix = "cpages_" + id
  return [prefix + "." + secret, id, prefix]
}

/** hashHighEntropy hex-encodes the SHA-256 of a high-entropy secret. */
export const hashHighEntropy = (value: string): string =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex")

/** hashLowEntropy is a keyed HMAC-SHA256 used for low-entropy codes/sessions. */
export const hashLowEntropy = (key: string, value: string): string =>
  crypto.createHmac("sha256", key).update(value, "utf8").digest("hex")

/** constantTimeSecretEqual compares two secrets in constant time. */
export const constantTimeSecretEqual = (left: string, right: string): boolean => {
  const l = crypto.createHash("sha256").update(left, "utf8").digest()
  const r = crypto.createHash("sha256").update(right, "utf8").digest()
  return crypto.timingSafeEqual(l, r)
}

/** constantTimeEqual compares two equal-length hex strings in constant time. */
export const constantTimeEqual = (left: string, right: string): boolean => {
  const l = Buffer.from(left, "utf8")
  const r = Buffer.from(right, "utf8")
  if (l.length !== r.length) return false
  return crypto.timingSafeEqual(l, r)
}

export const normalizeUserCode = (value: string): string =>
  value.trim().replaceAll("-", "").toUpperCase()

/** csrfToken derives a per-session CSRF token from the admin passcode. */
export const csrfToken = (passcode: string, raw: string): string =>
  hashLowEntropy(passcode, "csrf:" + raw)

/** decodeBase64UrlLen decodes base64url and returns its byte length, or -1. */
export const decodeBase64UrlByteLength = (value: string): number => {
  try {
    return Buffer.from(value, "base64url").length
  } catch {
    return -1
  }
}
