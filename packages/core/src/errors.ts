import { Data, Schema } from "effect"

/**
 * Raised when a known CLI binary cannot be resolved on the host.
 * Not fatal to a discovery scan — it is folded into an unavailable `CliInfo`.
 */
export class CliNotFoundError extends Data.TaggedError("CliNotFoundError")<{
  readonly kind: string
  readonly message: string
}> {}

/** Raised when invoking a CLI process fails (spawn error, non-zero exit, etc.). */
export class CliExecError extends Data.TaggedError("CliExecError")<{
  readonly kind: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Raised when the overall discovery scan cannot run (e.g. no command executor).
 * A `Schema.TaggedError` (not `Data.TaggedError`) because it crosses the RPC
 * boundary as the `Discovery.list` error — RPC error channels must be schemas.
 */
export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()(
  "DiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a requested session cannot be found in the store. A
 * `Schema.TaggedError` because it is the `Sessions.get` RPC error channel.
 */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: Schema.String
  }
) {}
