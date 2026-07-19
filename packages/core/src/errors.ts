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

/**
 * Raised when an adversarial review cannot run — no linked PR, no worktree, an
 * unresolvable PR head, or the reviewer harness failing to start. A
 * `Schema.TaggedError` so it crosses the RPC boundary as the `Review.run` error
 * channel.
 *
 * Note what is NOT an error here: a reviewer that runs but emits unparseable
 * output (a refusal, prose instead of JSON) succeeds with `note` set and no
 * findings. Only a review that could not *happen* fails.
 */
export class ReviewError extends Schema.TaggedError<ReviewError>()(
  "ReviewError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * An adversarial planning round could not produce a plan at all.
 *
 * Reserved for the cases where there is genuinely nothing to show: fewer than
 * two labs reachable, or the proposer itself failing. A missing or unhelpful
 * ADVERSARY is not an error — the round degrades to an unchallenged plan and
 * says so, because a plan that got less scrutiny than intended is still worth
 * having.
 */
export class PlanError extends Schema.TaggedError<PlanError>()(
  "PlanError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when a PTY-backed terminal cannot be spawned (bad cwd, shell missing,
 * fork failure). A `Schema.TaggedError` — it is the `Terminal.create` error
 * channel. Write/resize/kill/attach never fail (they no-op on an unknown id).
 */
export class TerminalError extends Schema.TaggedError<TerminalError>()(
  "TerminalError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Raised when the embedded browser preview can't act on a request — most
 * commonly a non-http(s) URL (the pane only loads localhost dev servers). A
 * `Schema.TaggedError` so it encodes across the RPC boundary; it is the error
 * channel for `BrowserPreview.open` / `BrowserPreview.navigate`.
 */
export class BrowserPreviewError extends Schema.TaggedError<BrowserPreviewError>()(
  "BrowserPreviewError",
  {
    message: Schema.String
  }
) {}
