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

/**
 * The subset of `SessionStatus` that may be WRITTEN BACK to the store.
 *
 * A run lives in the main process and dies with the app, so persisting a busy
 * status ("thinking"/"running") would strand the session in it forever after a
 * restart — reporting work for a run that no longer exists. Keeping the invariant
 * in the type means the boundary enforces it, rather than every caller having to
 * remember. Live, in-flight state is `SessionActivity`, which is never persisted.
 */
export const SettledSessionStatus = Schema.Literal("idle", "needs-input")
export type SettledSessionStatus = Schema.Schema.Type<typeof SettledSessionStatus>

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

/**
 * Automations for a session linked to a GitHub issue (design I2 toggles).
 * Defined before `Session` so it can be referenced inline below.
 */
export const IssueAutomations = Schema.Struct({
  /** Post agent progress comments back to the linked issue as work happens. */
  progressComments: Schema.Boolean,
  /** Close the linked issue automatically when the session's PR merges. */
  closeOnMerge: Schema.Boolean
})
export type IssueAutomations = Schema.Schema.Type<typeof IssueAutomations>

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
  /** Optional linked GitHub issue number (drives the sidebar badge + banner). */
  issueNumber: Schema.optional(Schema.Number),
  /** Linked issue web URL (the banner "Open" link). */
  issueUrl: Schema.optional(Schema.String),
  /** Linked issue title (banner). */
  issueTitle: Schema.optional(Schema.String),
  /** Linked issue label chips (banner). Same shape as `PrLabel`. */
  issueLabels: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) }))
  ),
  /** Issue automation prefs (progress comments / close-on-merge). */
  automations: Schema.optional(IssueAutomations),
  /**
   * A one-shot prompt to seed the composer with the first time the session is
   * opened (e.g. the task derived from a linked issue). Cleared once consumed so
   * it never re-seeds; HITL — the user reviews and sends it themselves.
   */
  initialPrompt: Schema.optional(Schema.String),
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
  autoDetectPr: Schema.Boolean,
  /**
   * Run an adversarial review automatically when a PR is opened or its head
   * advances. Off by default (a reviewer run costs real tokens); de-duped on the
   * PR head SHA so a poll loop can fire it safely. Absent on older configs.
   */
  autoAdversarialReview: Schema.optional(Schema.Boolean),
  /** Harness that runs the reviewer; absent = "claude". */
  reviewCli: Schema.optional(CliKind),
  /** Reviewer model id; absent = `DEFAULT_REVIEW_MODEL[reviewCli]` (Fable). */
  reviewModel: Schema.optional(Schema.String)
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
 * A review / comment entry in the PR timeline — top-level reviews and issue
 * comments only. Inline review comments live in `PrReviewThread` instead, so
 * they can keep their diff hunk and reply structure.
 *
 * `path`/`line` are retained for the "send to agent" code reference and are null
 * for everything the timeline currently carries.
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

/** GitHub's relationship between a commenter and the repo (drives the chips). */
export const PrAuthorAssociation = Schema.Literal(
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE"
)
export type PrAuthorAssociation = Schema.Schema.Type<typeof PrAuthorAssociation>

/** A reaction tally on a comment — e.g. `THUMBS_UP` × 1. Zero-counts are dropped. */
export const PrReaction = Schema.Struct({
  content: Schema.String,
  count: Schema.Number
})
export type PrReaction = Schema.Schema.Type<typeof PrReaction>

/** One comment inside an inline review thread. */
export const PrThreadComment = Schema.Struct({
  /** GraphQL node id. */
  id: Schema.String,
  /**
   * REST numeric id. Replies POST to `/pulls/{n}/comments/{databaseId}/replies`,
   * which does not accept a GraphQL node id.
   */
  databaseId: Schema.NullOr(Schema.Number),
  author: Schema.String,
  authorAvatarUrl: Schema.NullOr(Schema.String),
  /**
   * A GitHub App posted this (`__typename === "Bot"`). Note that bots report an
   * `authorAssociation` of `NONE`, so this is the only reliable bot signal.
   */
  isBot: Schema.Boolean,
  association: Schema.NullOr(PrAuthorAssociation),
  body: Schema.String,
  createdAt: Schema.String,
  reactions: Schema.Array(PrReaction)
})
export type PrThreadComment = Schema.Schema.Type<typeof PrThreadComment>

/**
 * An inline review thread anchored to a diff hunk — GitHub's unit of inline
 * review conversation, and what the Pull Request tab renders instead of a flat
 * list of comments.
 *
 * `line`/`startLine` are the CURRENT anchor and GitHub nulls BOTH of them once
 * the thread is outdated (the hunk has moved), which is the common case on any
 * PR that has been pushed to since review. `originalLine`/`originalStartLine`
 * are the anchor at review time and always survive — so rendering the
 * "Comment on lines +x to +y" caption means falling back to them.
 * A null start (after that fallback) means a single-line comment.
 */
export const PrReviewThread = Schema.Struct({
  id: Schema.String,
  /**
   * Node id of the review that opened the thread, used to group threads under a
   * single "<author> reviewed <when>" header. Null when GitHub reports none.
   */
  reviewId: Schema.NullOr(Schema.String),
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  startLine: Schema.NullOr(Schema.Number),
  originalLine: Schema.NullOr(Schema.Number),
  originalStartLine: Schema.NullOr(Schema.Number),
  /** The raw unified-diff hunk (`@@ …` header included) the thread is anchored to. */
  diffHunk: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  resolvedBy: Schema.NullOr(Schema.String),
  comments: Schema.Array(PrThreadComment)
})
export type PrReviewThread = Schema.Schema.Type<typeof PrReviewThread>

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
  /** Inline review threads, grouped and rendered separately from `timeline`. */
  reviewThreads: Schema.Array(PrReviewThread),
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

/**
 * A lightweight open-issue list-item for the "new session from an issue" picker
 * and the attach-issue dialog (from `gh issue list --json …`). Mirrors
 * `PrSummary`; `body` seeds the prefilled task.
 */
export const IssueSummary = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** Issue web URL (for "Open ⧉"). */
  url: Schema.String,
  /** Issue body (markdown) — seeds the composer's prefilled task. */
  body: Schema.String,
  labels: Schema.Array(PrLabel),
  author: GithubUser,
  assignees: Schema.Array(GithubUser),
  /** ISO-8601 last-updated timestamp (for the relative "2h ago" label). */
  updatedAt: Schema.String
})
export type IssueSummary = Schema.Schema.Type<typeof IssueSummary>

/** A comment on a GitHub issue (for the Issue tab's rich view). */
export const IssueComment = Schema.Struct({
  author: GithubUser,
  body: Schema.String,
  createdAt: Schema.String
})
export type IssueComment = Schema.Schema.Type<typeof IssueComment>

/**
 * The full GitHub issue view model for the Issue tab — a recreation of the
 * issue page (from `gh issue view --json …`). Read-only.
 */
export const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literal("open", "closed"),
  body: Schema.String,
  author: GithubUser,
  assignees: Schema.Array(GithubUser),
  labels: Schema.Array(PrLabel),
  createdAt: Schema.String,
  comments: Schema.Array(IssueComment)
})
export type Issue = Schema.Schema.Type<typeof Issue>

/** A pending inline review comment anchored to a file + line. */
export const ReviewComment = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  body: Schema.String,
  side: Schema.optional(Schema.Literal("LEFT", "RIGHT"))
})
export type ReviewComment = Schema.Schema.Type<typeof ReviewComment>

// ── Adversarial review ───────────────────────────────────────────────────────

/**
 * How bad a finding is, as argued by the reviewer. The reviewer is asked for
 * COVERAGE (report everything, tag it honestly) rather than to self-filter —
 * a model told "only report high-severity issues" silently drops findings it
 * judges below the bar, which reads as a recall regression. Filtering is the
 * UI's job, which is why this field exists.
 */
export const ReviewSeverity = Schema.Literal("critical", "major", "minor", "nit")
export type ReviewSeverity = Schema.Schema.Type<typeof ReviewSeverity>

/** One defect the adversarial reviewer argues for, anchored to file+line where it can be. */
export const ReviewFinding = Schema.Struct({
  /** Stable id within a review — the key for "already routed to the agent". */
  id: Schema.String,
  /** Repo-relative path, or null for a finding about the change as a whole. */
  path: Schema.NullOr(Schema.String),
  /** 1-indexed line in the file's NEW side, or null when not line-anchored. */
  line: Schema.NullOr(Schema.Number),
  /** End of a multi-line range, or null for a single line. */
  endLine: Schema.NullOr(Schema.Number),
  severity: ReviewSeverity,
  /** One-sentence statement of the defect. */
  title: Schema.String,
  /** Why it's wrong — the concrete failure, not a style opinion. */
  rationale: Schema.String,
  /** A concrete fix, or null when the reviewer only raises the problem. */
  suggestion: Schema.NullOr(Schema.String)
})
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>

/**
 * The result of one adversarial review run against a PR head, persisted per
 * session under `~/starbase/reviews/<sessionId>.json` so it survives reloads.
 */
export const AdversarialReview = Schema.Struct({
  sessionId: Schema.String,
  prNumber: Schema.Number,
  /**
   * The PR head commit the review ran against — the de-dupe key. An auto-review
   * whose head SHA matches the stored one is a no-op, which is what keeps the
   * poll-driven trigger from re-spawning a reviewer on every tick.
   */
  headSha: Schema.String,
  /** The harness that ran the reviewer. */
  cli: CliKind,
  /** The model the reviewer ran on (e.g. "claude-fable-5"). */
  model: Schema.String,
  /** ISO-8601 timestamp of the run. */
  createdAt: Schema.String,
  findings: Schema.Array(ReviewFinding),
  /**
   * Set when the reviewer ran but emitted no parseable findings block — a
   * refusal, a "looks good to me", or malformed output. Carries the raw text so
   * the user sees *something* rather than an empty list that looks like success.
   */
  note: Schema.NullOr(Schema.String)
})
export type AdversarialReview = Schema.Schema.Type<typeof AdversarialReview>

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

/**
 * Parameters for creating a session from a GitHub issue. Unlike
 * `CreateSessionFromPrInput` (which checks out an existing PR branch), this
 * forks a fresh `<number>-<slug>` branch off `baseBranch` like a blank session,
 * links the issue, and seeds the task from the issue title + body.
 */
export const CreateSessionFromIssueInput = Schema.Struct({
  /** Absolute path to the origin repo. */
  repoPath: Schema.String,
  /** The repo's folder name, used for grouping + the worktree directory. */
  repoName: Schema.String,
  /** Which CLI will drive the session. */
  cli: CliKind,
  /** The branch to fork the worktree from. */
  baseBranch: Schema.String,
  /** The issue to link + seed the task from. */
  issue: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    url: Schema.String,
    body: Schema.String,
    labels: Schema.Array(PrLabel)
  }),
  /**
   * The (editable) task to seed the composer with — prefilled from the issue in
   * the dialog. Empty falls back to the issue title + body.
   */
  task: Schema.String,
  /** Automations to enable on the new session. */
  automations: IssueAutomations
})
export type CreateSessionFromIssueInput = Schema.Schema.Type<typeof CreateSessionFromIssueInput>

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

// ── Browser preview (embedded WebContentsView over a localhost dev server) ────

/**
 * The on-screen rectangle (CSS pixels, relative to the renderer's top-left) the
 * embedded browser `WebContentsView` should occupy. The renderer streams this
 * from the preview pane's `getBoundingClientRect` so the native view stays
 * aligned with its placeholder as the layout changes.
 */
export const BrowserBounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number
})
export type BrowserBounds = Schema.Schema.Type<typeof BrowserBounds>

// The conversation/transcript model (Message, ToolCall, ApprovalGate) and the
// normalized StreamEvent seam live in ./conversation.ts.
