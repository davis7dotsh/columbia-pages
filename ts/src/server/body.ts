import { Data, Effect, type Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

export class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string
}> {}

// Decodes the JSON request body against a schema, mapping every failure to a
// 400-shaped error like the Go server's decode() helper. Unknown fields are
// rejected (Go's DisallowUnknownFields); the 8 MiB body cap is enforced by
// Bun's maxRequestBodySize server option.
export const jsonBody = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>) =>
  HttpServerRequest.schemaBodyJson(schema, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new BadRequest({ message: `invalid JSON: ${error}` }))
  )

// Decodes an application/x-www-form-urlencoded body (admin forms).
export const formBody = <
  A,
  I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  RD,
  RE
>(
  schema: Schema.Codec<A, I, RD, RE>
) =>
  HttpServerRequest.schemaBodyUrlParams(schema).pipe(
    Effect.mapError(() => new BadRequest({ message: "invalid form" }))
  )
