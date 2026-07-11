import { Schema } from "effect"

/**
 * Domain schemas for Starbase. These are Effect `Schema`s so they can be reused
 * for RPC payload encode/decode, persistence, and runtime validation. The plain
 * TypeScript types are derived from the schemas via `Schema.Schema.Type`.
 */

// ── CLI discovery ────────────────────────────────────────────────────────────

/** The coding CLIs Starbase knows how to wrap. */
export const CliKind = Schema.Literal("claude", "codex", "cursor")
export type CliKind = Schema.Schema.Type<typeof CliKind>

/** The outcome of probing for one CLI on the host. */
export const CliInfo = Schema.Struct({
  kind: CliKind,
  /** Human label, e.g. "Claude Code". */
  label: Schema.String,
  /** Resolved absolute path to the binary, or null when not found. */
  binPath: Schema.NullOr(Schema.String),
  /** Reported version string, or null when unknown / unavailable. */
  version: Schema.NullOr(Schema.String),
  available: Schema.Boolean
})
export type CliInfo = Schema.Schema.Type<typeof CliInfo>

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Lifecycle status of an agent session, mirrored in the sidebar pills. */
export const SessionStatus = Schema.Literal(
  "thinking",
  "running",
  "needs-input",
  "idle",
  "done"
)
export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>

/** Added / removed line counts for a session's working diff. */
export const DiffStat = Schema.Struct({
  added: Schema.Number,
  removed: Schema.Number
})
export type DiffStat = Schema.Schema.Type<typeof DiffStat>

/**
 * Human-in-the-loop permission mode for a session:
 * - `ask` — pause for approval before every edit and command,
 * - `accept-edits` — auto-apply file edits, still pause for shell commands,
 * - `auto` — auto-apply edits and run allowlisted commands without prompting.
 */
export const PermissionMode = Schema.Literal("ask", "accept-edits", "auto")
export type PermissionMode = Schema.Schema.Type<typeof PermissionMode>

/** A single agent session shown in the sidebar and opened in the main pane. */
export const Session = Schema.Struct({
  id: Schema.String,
  /** owner/repo, e.g. "trigify/api". */
  repo: Schema.String,
  branch: Schema.String,
  title: Schema.String,
  status: SessionStatus,
  /** Which CLI is driving this session. */
  cli: CliKind,
  diff: DiffStat,
  /** Optional linked pull-request number. */
  prNumber: Schema.NullOr(Schema.Number),
  costUsd: Schema.Number,
  tokens: Schema.Number,
  /** ISO-8601 last-activity timestamp. */
  updatedAt: Schema.String,
  /** Absolute path to this session's isolated git worktree, when one exists. */
  worktreePath: Schema.optional(Schema.String),
  /** The branch this session's worktree was forked from. */
  baseBranch: Schema.optional(Schema.String),
  /** HITL permission mode; defaults to "accept-edits" when absent. */
  mode: Schema.optional(PermissionMode),
  /** Commands the operator chose to "Always allow" for this session. */
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  /** The harness model id for this session; defaults to the harness default. */
  model: Schema.optional(Schema.String)
})
export type Session = Schema.Schema.Type<typeof Session>

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * Persisted app configuration, stored at `~/starbase/config.json`. `reposDir` is
 * null until the user completes first-run setup by choosing a repos directory.
 */
export const WorkspaceConfig = Schema.Struct({
  /** Absolute path to the directory that contains the user's git repos. */
  reposDir: Schema.NullOr(Schema.String),
  /** ISO-8601 timestamp of when the config was first created. */
  createdAt: Schema.String
})
export type WorkspaceConfig = Schema.Schema.Type<typeof WorkspaceConfig>

/** A git repository discovered under the configured repos directory. */
export const Repo = Schema.Struct({
  /** Folder name, used as the sidebar group label (e.g. "trigify-app"). */
  name: Schema.String,
  /** Absolute path to the repo's working tree. */
  path: Schema.String,
  /** The repo's default branch (e.g. "main"), or null if it can't be resolved. */
  defaultBranch: Schema.NullOr(Schema.String),
  /** The branch currently checked out in the repo, or null (detached/bare). */
  currentBranch: Schema.NullOr(Schema.String),
  /** `origin` remote URL, or null when there is no origin. */
  remoteUrl: Schema.NullOr(Schema.String),
  /** "owner/repo" parsed from a GitHub origin, or null. */
  githubSlug: Schema.NullOr(Schema.String)
})
export type Repo = Schema.Schema.Type<typeof Repo>

/** An isolated git worktree created for a session. */
export const Worktree = Schema.Struct({
  /** Absolute path to the worktree, under `~/starbase/worktrees/…`. */
  path: Schema.String,
  /** The new branch checked out in the worktree (e.g. "starbase/refactor-auth"). */
  branch: Schema.String,
  /** The branch the worktree was forked from. */
  baseBranch: Schema.String,
  /** Absolute path to the origin repo the worktree belongs to. */
  repoPath: Schema.String
})
export type Worktree = Schema.Schema.Type<typeof Worktree>

/** Detection + auth state of the GitHub CLI (`gh`). Never fails; folds to false. */
export const GhStatus = Schema.Struct({
  /** `gh` is installed and on PATH. */
  available: Schema.Boolean,
  /** `gh auth status` reported an authenticated account. */
  authenticated: Schema.Boolean,
  /** The authenticated account handle, or null. */
  login: Schema.NullOr(Schema.String),
  /** The authenticated host (e.g. "github.com"), or null. */
  host: Schema.NullOr(Schema.String),
  /** Reported `gh` version, or null when unavailable. */
  version: Schema.NullOr(Schema.String)
})
export type GhStatus = Schema.Schema.Type<typeof GhStatus>

/** Parameters for creating a new session (and its isolated worktree). */
export const CreateSessionInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Human title for the session (also the source of the branch/worktree slug). */
  title: Schema.String,
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The branch to fork the worktree from. */
  baseBranch: Schema.String
})
export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInput>

// The conversation/transcript model (Message, ToolCall, ApprovalGate) and the
// normalized StreamEvent seam live in ./conversation.ts.
