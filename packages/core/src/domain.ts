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
 * - `auto` — auto-apply edits and run allowlisted commands without prompting,
 * - `plan` — read-only planning: the agent designs a plan for review and cannot
 *   edit or run commands until the operator approves it (Claude harness only).
 */
export const PermissionMode = Schema.Literal("ask", "accept-edits", "auto", "plan")
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
  /**
   * The harness's own session id for this conversation (Claude/Codex), persisted
   * so the agent RESUMES its full memory across app restarts — the in-memory
   * resume map is otherwise lost on quit, and "continue" would start the harness
   * fresh (re-reading the plan, re-checking state) despite the visible transcript.
   */
  resumeId: Schema.optional(Schema.String),
  /** HITL permission mode; defaults to "accept-edits" when absent. */
  mode: Schema.optional(PermissionMode),
  /** Commands the operator chose to "Always allow" for this session. */
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  /** The harness model id for this session; defaults to the harness default. */
  model: Schema.optional(Schema.String),
  /**
   * True only for sessions the agent auto-names (refreshed each turn). A manual
   * rename — or a title typed at creation — pins the name (false). Absent is
   * treated as pinned, so legacy/user-named sessions are never auto-overwritten.
   */
  autoTitle: Schema.optional(Schema.Boolean),
  /**
   * Whether the session is archived — set automatically once its linked PR is
   * merged or closed. Archived sessions are read-only (collapsed into the
   * "Archived" sidebar group) but never deleted; the user restores or deletes them.
   */
  archived: Schema.optional(Schema.Boolean),
  /** Why the session was archived (drives the "Merged"/"Closed" pill). */
  archiveReason: Schema.optional(Schema.Literal("merged", "closed")),
  /** ISO-8601 timestamp the session was archived (for the "2d ago" label). */
  archivedAt: Schema.optional(Schema.String)
})
export type Session = Schema.Schema.Type<typeof Session>

/** Why a session was archived — matches `Session.archiveReason`. */
export const ArchiveReason = Schema.Literal("merged", "closed")
export type ArchiveReason = Schema.Schema.Type<typeof ArchiveReason>

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * The user's GitHub integration preferences. Persisted inside `WorkspaceConfig`;
 * absent until the user configures the integration (so it stays optional there).
 */
export const GithubConfig = Schema.Struct({
  /** Master switch for the pull-request features (PR/Code Review tabs, writes). */
  enabled: Schema.Boolean,
  /** Open a PR automatically once a session's branch has pushable commits. */
  autoCreatePr: Schema.Boolean,
  /** Auto-detect a PR already open on a session's branch and link it. */
  autoDetectPr: Schema.Boolean
})
export type GithubConfig = Schema.Schema.Type<typeof GithubConfig>

/** The user's git behaviour preferences. Persisted inside `WorkspaceConfig`. */
export const GitConfig = Schema.Struct({
  /**
   * Allow opening a session from a PR whose head branch is already checked out
   * in another worktree (e.g. your main repo). When on, the session's worktree
   * shares the branch ref (`git checkout --ignore-other-worktrees`); when off,
   * git's safeguard is respected and the create fails with a clear error.
   */
  shareCheckedOutBranches: Schema.Boolean
})
export type GitConfig = Schema.Schema.Type<typeof GitConfig>

/**
 * Extended-thinking / reasoning budget for a harness, mapped from the design's
 * "thinking budget" segments. Harness-specific in meaning; persisted per provider.
 */
export const ReasoningEffort = Schema.Literal("off", "think", "think-hard", "ultrathink")
export type ReasoningEffort = Schema.Schema.Type<typeof ReasoningEffort>

/** Tone / verbosity preset for a harness's replies (Claude "output style"). */
export const OutputStyle = Schema.Literal("default", "explanatory", "concise")
export type OutputStyle = Schema.Schema.Type<typeof OutputStyle>

/**
 * Per-CLI provider defaults a new session inherits — the "Settings · Providers"
 * levers (design E10). Keyed by `CliKind` inside `WorkspaceConfig.providers`.
 * Only `defaultMode`/`defaultModel` are consumed at session creation today; the
 * remaining levers are persisted and surfaced in the settings view for future
 * adapter wiring.
 */
export const ProviderConfig = Schema.Struct({
  /** Whether this provider is offered when starting a session. */
  enabled: Schema.Boolean,
  /** Permission mode new sessions start in (maps to the harness `--permission-mode`). */
  defaultMode: PermissionMode,
  /** Default harness model id for new sessions; absent = the harness default. */
  defaultModel: Schema.optional(Schema.String),
  /** Small/fast model for summaries & side tasks; absent = the harness default. */
  backgroundModel: Schema.optional(Schema.String),
  /** Extended-thinking budget; absent = the harness default. */
  reasoningEffort: Schema.optional(ReasoningEffort),
  /** Reply tone/verbosity preset; absent = the harness default. */
  outputStyle: Schema.optional(OutputStyle)
})
export type ProviderConfig = Schema.Schema.Type<typeof ProviderConfig>

/**
 * Per-CLI provider defaults, keyed by `CliKind`. Partial — a config only carries
 * entries for the CLIs the user has actually customised (a literal-key record
 * would otherwise require every CLI to be present).
 */
export const ProvidersConfig = Schema.partial(
  Schema.Record({ key: CliKind, value: ProviderConfig })
)
export type ProvidersConfig = Schema.Schema.Type<typeof ProvidersConfig>

/**
 * Persisted app configuration, stored at `~/starbase/config.json`. `reposDir` is
 * null until the user completes first-run setup by choosing a repos directory.
 */
export const WorkspaceConfig = Schema.Struct({
  /** Absolute path to the directory that contains the user's git repos. */
  reposDir: Schema.NullOr(Schema.String),
  /** ISO-8601 timestamp of when the config was first created. */
  createdAt: Schema.String,
  /** GitHub integration prefs; absent until configured (older configs lack it). */
  github: Schema.optional(GithubConfig),
  /** Git behaviour prefs; absent until configured (older configs lack it). */
  git: Schema.optional(GitConfig),
  /**
   * Absolute paths of the repos the user has starred, so the New Session picker
   * can surface them first. Absent on older configs (treated as an empty list).
   */
  starredRepos: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Absolute paths of the repos the user has collapsed in the sidebar (their
   * sessions hidden). The reserved sentinel `"__archived__"` collapses the
   * Archived group. Absent on older configs (treated as an empty list).
   */
  collapsedRepos: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Absolute path of the repo used for the most recent session create, so the
   * New Session dialog can preselect it. Absent until the first create.
   */
  lastRepoPath: Schema.optional(Schema.String),
  /**
   * Per-CLI provider defaults (model, mode, reasoning, …) from the Settings ·
   * Providers view. Absent on older configs (each provider falls back to the
   * harness defaults).
   */
  providers: Schema.optional(ProvidersConfig)
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

// ── Pull requests / code review ──────────────────────────────────────────────

/** Overall state of a pull request. "draft" is synthesized from `isDraft`. */
export const PrState = Schema.Literal("open", "closed", "merged", "draft")
export type PrState = Schema.Schema.Type<typeof PrState>

/** Normalized CI check status (mapped from `gh pr checks` buckets). */
export const PrCheckStatus = Schema.Literal("pass", "fail", "running", "pending")
export type PrCheckStatus = Schema.Schema.Type<typeof PrCheckStatus>

/** How a reviewer/timeline review resolved. "pending" = requested, not yet done. */
export const PrReviewKind = Schema.Literal(
  "commented",
  "approved",
  "changes_requested",
  "pending"
)
export type PrReviewKind = Schema.Schema.Type<typeof PrReviewKind>

/** The kind of review a composer submits back to GitHub. */
export const ReviewSubmitKind = Schema.Literal("comment", "approve", "request-changes")
export type ReviewSubmitKind = Schema.Schema.Type<typeof ReviewSubmitKind>

/** The strategy `gh pr merge` uses when merging a pull request. */
export const PrMergeMethod = Schema.Literal("merge", "squash", "rebase")
export type PrMergeMethod = Schema.Schema.Type<typeof PrMergeMethod>

/** A GitHub account reference (author / reviewer). */
export const GithubUser = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String)
})
export type GithubUser = Schema.Schema.Type<typeof GithubUser>

/** A PR label chip. */
export const PrLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String)
})
export type PrLabel = Schema.Schema.Type<typeof PrLabel>

/** A requested/actual reviewer and their current state. */
export const PrReviewer = Schema.Struct({
  login: Schema.String,
  state: PrReviewKind
})
export type PrReviewer = Schema.Schema.Type<typeof PrReviewer>

/** One CI check on a PR. */
export const PrCheck = Schema.Struct({
  name: Schema.String,
  status: PrCheckStatus,
  /** Link to the run's details page, or null. */
  detailsUrl: Schema.NullOr(Schema.String),
  /** Duration in milliseconds when known, or null (still running / not reported). */
  durationMs: Schema.NullOr(Schema.Number)
})
export type PrCheck = Schema.Schema.Type<typeof PrCheck>

/**
 * A review / comment entry in the PR timeline. `path`/`line` are set only for
 * inline review comments (null for issue comments / v1 — see the plan).
 */
export const PrTimelineItem = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  kind: Schema.Literal("commented", "approved", "changes_requested"),
  body: Schema.String,
  createdAt: Schema.String,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number)
})
export type PrTimelineItem = Schema.Schema.Type<typeof PrTimelineItem>

/** A changed file in a PR, for the Code Review file list. */
export const PrFileChange = Schema.Struct({
  path: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  /** Inline-comment count on this file (0 in v1 — not exposed by `gh pr view`). */
  commentCount: Schema.Number,
  /** Whether the reviewer marked the file viewed (false in v1). */
  viewed: Schema.Boolean
})
export type PrFileChange = Schema.Schema.Type<typeof PrFileChange>

/**
 * A pull request linked to a session, assembled from `gh pr view` + `gh pr
 * checks`. Read-only view model for the Pull Request tab.
 */
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  state: PrState,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  url: Schema.String,
  /** Source (PR head) branch. */
  headRefName: Schema.String,
  /** Target (base) branch. */
  baseRefName: Schema.String,
  isDraft: Schema.Boolean,
  author: GithubUser,
  createdAt: Schema.String,
  commits: Schema.Number,
  changedFiles: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  labels: Schema.Array(PrLabel),
  reviewers: Schema.Array(PrReviewer),
  timeline: Schema.Array(PrTimelineItem),
  checks: Schema.Array(PrCheck),
  /** GitHub `mergeable` (MERGEABLE | CONFLICTING | UNKNOWN), or null. */
  mergeable: Schema.NullOr(Schema.String),
  /** GitHub `mergeStateStatus` (CLEAN | BLOCKED | DIRTY | BEHIND | …), or null. */
  mergeStateStatus: Schema.NullOr(Schema.String),
  /** Human-readable reasons merging is blocked (synthesized). Empty when clear. */
  mergeBlockers: Schema.Array(Schema.String)
})
export type PullRequest = Schema.Schema.Type<typeof PullRequest>

/**
 * A lightweight PR list-item for the "new session from a PR" picker (from
 * `gh pr list --json …`). Distinct from the full `PullRequest` view model —
 * only the fields the picker row + session creation need.
 */
export const PrSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** Source (PR head) branch — the session's worktree checks this out. */
  headRefName: Schema.String,
  /** Target (base) branch. */
  baseRefName: Schema.String,
  author: GithubUser,
  state: PrState,
  isDraft: Schema.Boolean,
  additions: Schema.Number,
  deletions: Schema.Number,
  /** ISO-8601 last-updated timestamp (for the relative "2h ago" label). */
  updatedAt: Schema.String
})
export type PrSummary = Schema.Schema.Type<typeof PrSummary>

/** A pending inline review comment anchored to a file + line. */
export const ReviewComment = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  body: Schema.String,
  side: Schema.optional(Schema.Literal("LEFT", "RIGHT"))
})
export type ReviewComment = Schema.Schema.Type<typeof ReviewComment>

/** Parameters for creating a new session (and its isolated worktree). */
export const CreateSessionInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /**
   * Optional session title. When omitted/blank the session is auto-named by the
   * agent (and the branch slug falls back to "untitled-session-<stamp>"); when
   * provided it seeds the title (pinned) and a readable branch slug.
   */
  title: Schema.optional(Schema.String),
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The branch to fork the worktree from. */
  baseBranch: Schema.String
})
export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInput>

/**
 * Parameters for creating a session from an *existing* pull request. Unlike
 * `CreateSessionInput` (which forks a fresh `starbase/<slug>` branch), this
 * checks out the PR's head branch into the worktree so the agent's commits
 * update the PR directly. Title + base come from the PR itself.
 */
export const CreateSessionFromPrInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The pull request to base the session on. */
  pr: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    headRefName: Schema.String,
    baseRefName: Schema.String
  })
})
export type CreateSessionFromPrInput = Schema.Schema.Type<typeof CreateSessionFromPrInput>

// ── Terminal ─────────────────────────────────────────────────────────────────

/** Lifecycle of a PTY-backed terminal. */
export const TerminalStatus = Schema.Literal("running", "exited")
export type TerminalStatus = Schema.Schema.Type<typeof TerminalStatus>

/**
 * Metadata for one PTY-backed terminal tab. The live byte stream rides
 * `Terminal.attach`; this is just the sidebar/tab-strip descriptor. Terminals
 * are scoped to a session (their cwd is the session's worktree).
 */
export const TerminalInfo = Schema.Struct({
  /** Opaque id (also the RPC key for write/resize/kill/attach). */
  id: Schema.String,
  /** The session this terminal belongs to. */
  sessionId: Schema.String,
  /** Tab label — the shell's base name, e.g. "zsh" or "node". */
  title: Schema.String,
  /** Absolute working directory the shell was spawned in. */
  cwd: Schema.String,
  /** Whether the shell process is still alive. */
  status: TerminalStatus,
  /** Exit code once the shell has exited (null while running). */
  exitCode: Schema.NullOr(Schema.Number)
})
export type TerminalInfo = Schema.Schema.Type<typeof TerminalInfo>

/**
 * One frame on a terminal's `attach` stream. Output frames carry a
 * *coalesced* run of PTY bytes (the service batches raw `onData` chunks on a
 * short tick / size threshold so throughput events stay bounded — the crux of
 * the perf story). An `exit` frame is emitted once, last, when the shell dies.
 */
export const TerminalChunk = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("data"), data: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("exit"), exitCode: Schema.Number })
)
export type TerminalChunk = Schema.Schema.Type<typeof TerminalChunk>

// The conversation/transcript model (Message, ToolCall, ApprovalGate) and the
// normalized StreamEvent seam live in ./conversation.ts.
