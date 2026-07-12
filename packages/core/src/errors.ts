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

/**
 * Raised when an operation needs a configured repos directory but the user has
 * not completed first-run setup yet. A `Schema.TaggedError` — it is the
 * `Workspace.repos` RPC error channel.
 */
export class WorkspaceNotConfiguredError extends Schema.TaggedError<WorkspaceNotConfiguredError>()(
  "WorkspaceNotConfiguredError",
  {}
) {}

/**
 * Raised when reading or writing the persisted config/sessions files fails.
 * A `Schema.TaggedError` so it can cross the RPC boundary.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a git operation (branch lookup, `worktree add`, repo scan) fails.
 * A `Schema.TaggedError` — it is the error channel for the worktree/branch RPCs.
 */
export class GitError extends Schema.TaggedError<GitError>()(
  "GitError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a `gh` (GitHub CLI) write fails — `gh pr create`, `gh pr comment`,
 * `gh pr review`. A `Schema.TaggedError` so it can cross the RPC boundary as the
 * error channel for the `Github.*` write RPCs. Reads never fail (fold to null).
 */
export class GhError extends Schema.TaggedError<GhError>()(
  "GhError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}
