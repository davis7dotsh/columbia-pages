import { Data, Runtime } from "effect"

// A user-facing failure: printed as `error: <message>` and exits non-zero,
// like the Go CLI's top-level error handling.
export class CliUserError extends Data.TaggedError("CliUserError")<{
  readonly message: string
}> {}

export const cliError = (message: string) => new CliUserError({ message })

// "server <status>: <message>" from an error response body, preferring the
// JSON {"error": "..."} field and falling back to the raw text.
export const serverErrorMessage = (status: number, body: string): string => {
  let message = body.trim()
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === "string" && parsed.error !== "") message = parsed.error
  } catch {
    // not JSON — keep the raw body
  }
  return `server ${status}: ${message}`
}

// Terminates with exit code 1 after the message has already been printed.
// [Runtime.errorReported] = false suppresses runMain's own error log: the
// runtime runs `getErrorReported(error) ? Effect.logError(cause) : Effect.void`,
// so `true` here double-prints every CLI error (verified against
// effect@4.0.0-beta.92 Runtime.js).
export class SilentExit extends Data.TaggedError("SilentExit")<{}> {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}
