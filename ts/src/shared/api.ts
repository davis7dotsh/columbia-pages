import { Schema } from "effect"

// Wire formats shared by the server and the CLI. Timestamps travel as
// RFC 3339 strings, exactly like the Go implementation.

export const PageResponse = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  slug: Schema.optionalKey(Schema.String),
  raw: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optionalKey(Schema.Number)
})
export type PageResponse = typeof PageResponse.Type

export const ListResponse = Schema.Struct({
  pages: Schema.Array(PageResponse)
})

export const AuthInfoResponse = Schema.Struct({
  ok: Schema.Boolean,
  credential_type: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  label: Schema.optionalKey(Schema.String),
  expires_at: Schema.optional(Schema.NullOr(Schema.String))
})
export type AuthInfoResponse = typeof AuthInfoResponse.Type

export const DiscoveryResponse = Schema.Struct({
  control_url: Schema.String,
  content_url: Schema.String,
  device_authorization: Schema.Boolean
})
export type DiscoveryResponse = typeof DiscoveryResponse.Type

export const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number
})
export type DeviceCodeResponse = typeof DeviceCodeResponse.Type

export const DeviceTokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

export const ErrorResponse = Schema.Struct({
  error: Schema.String
})

export const SCOPE_READ = "pages:read"
export const SCOPE_WRITE = "pages:write"
