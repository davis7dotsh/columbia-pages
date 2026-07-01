import { Data, Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

export const maxBodyBytes = 8 * 1024 * 1024 // 8 MiB cap on uploaded HTML

export class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {}

/**
 * decodeBody reads and parses a JSON object body, enforcing the size cap and
 * rejecting unknown fields (mirrors Go's DisallowUnknownFields).
 */
export const decodeBody = (
  allowed: ReadonlyArray<string>,
): Effect.Effect<Record<string, unknown>, BadRequest, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    // Reject an oversized declared body before reading it into memory.
    const declared = Number(req.headers["content-length"] ?? "")
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return yield* new BadRequest({ message: "invalid JSON: http: request body too large" })
    }
    const text = yield* req.text.pipe(
      Effect.mapError(() => new BadRequest({ message: "invalid JSON: could not read request body" })),
    )
    if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
      return yield* new BadRequest({ message: "invalid JSON: http: request body too large" })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      return yield* new BadRequest({ message: "invalid JSON: " + (e as Error).message })
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* new BadRequest({ message: "invalid JSON: expected a JSON object" })
    }
    const obj = parsed as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        return yield* new BadRequest({ message: `invalid JSON: json: unknown field "${key}"` })
      }
    }
    return obj
  })
