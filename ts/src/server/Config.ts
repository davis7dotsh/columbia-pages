import { Context, Effect, Layer } from "effect"
import { parseConfiguredOrigin } from "../internal/origin.ts"
import { RateLimiter } from "./RateLimiter.ts"

export interface ServerConfigShape {
  readonly adminPasscode: string
  readonly baseURL: string // content origin
  readonly controlURL: string // control origin
  readonly publicHost: string
  readonly controlHost: string
  readonly tokenTTLDays: number
  readonly secureCookie: boolean
  readonly trustForwardedIP: boolean
}

export interface RawConfig {
  readonly adminPasscode: string
  readonly publicBaseURL: string
  readonly controlBaseURL: string
  readonly tokenTTLDays: number
  readonly trustForwardedIP: boolean
}

/** buildConfig validates the raw environment config and rejects unsafe combos. */
export const buildConfig = (cfg: RawConfig): ServerConfigShape => {
  let publicParsed
  try {
    publicParsed = parseConfiguredOrigin(cfg.publicBaseURL)
  } catch (e) {
    throw new Error(`PUBLIC_BASE_URL: ${(e as Error).message}`)
  }
  let controlParsed
  try {
    controlParsed = parseConfiguredOrigin(cfg.controlBaseURL)
  } catch (e) {
    throw new Error(`CONTROL_BASE_URL: ${(e as Error).message}`)
  }
  if (cfg.adminPasscode === "") throw new Error("COLUMBIA_PAGES_ADMIN_PASSCODE is required")
  if (publicParsed.origin === "") throw new Error("PUBLIC_BASE_URL is required")
  if (controlParsed.origin === "") throw new Error("CONTROL_BASE_URL is required")
  if (publicParsed.origin === controlParsed.origin) {
    throw new Error("PUBLIC_BASE_URL and CONTROL_BASE_URL must use different origins")
  }
  let ttl = cfg.tokenTTLDays
  if (ttl === 0) ttl = 90
  if (ttl < 1 || ttl > 365) throw new Error("COLUMBIA_PAGES_TOKEN_TTL_DAYS must be between 1 and 365")
  return {
    adminPasscode: cfg.adminPasscode,
    baseURL: publicParsed.origin,
    controlURL: controlParsed.origin,
    publicHost: publicParsed.host,
    controlHost: controlParsed.host,
    tokenTTLDays: ttl,
    secureCookie: controlParsed.secure,
    trustForwardedIP: cfg.trustForwardedIP,
  }
}

export class ServerConfig extends Context.Tag("ServerConfig")<ServerConfig, ServerConfigShape>() {
  static readonly layer = (raw: RawConfig) => Layer.sync(ServerConfig, () => buildConfig(raw))
}

export class Limiter extends Context.Tag("Limiter")<Limiter, RateLimiter>() {
  static readonly layer = Layer.sync(Limiter, () => new RateLimiter(4096))
}

/** currentTime is a service so tests can control the clock (mirrors s.now). */
export class CurrentTime extends Context.Tag("CurrentTime")<CurrentTime, { readonly now: () => Date }>() {
  static readonly layer = Layer.sync(CurrentTime, () => ({ now: () => new Date() }))
}

export const now = Effect.map(CurrentTime, (c) => c.now())
