import {
  AdversarialReview,
  ArchiveReason,
  Attachment,
  AuthProvider,
  AuthSession,
  BrowserBounds,
  CliInfo,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GateDecision,
  GhStatus,
  GitConfig,
  GithubConfig,
  Issue,
  IssueAutomations,
  IssueSummary,
  Message,
  ModelOption,
  PermissionMode,
  PrFileChange,
  PrMergeMethod,
  PrState,
  PrSummary,
  ProviderConfig,
  ProviderModels,
  PullRequest,
  QuestionAnswer,
  Repo,
  ReviewSubmitKind,
  Session,
  SessionStatus,
  Skill,
  StreamEvent,
  TerminalChunk,
  TerminalInfo,
  Usage,
  WorkspaceConfig
} from "@starbase/core"
import {
  AuthError,
  BrowserPreviewError,
  ConfigError,
  DiscoveryError,
  GhError,
  GitError,
  ReviewError,
  SessionNotFoundError,
  TerminalError,
  WorkspaceNotConfiguredError
} from "@starbase/core"
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

/**
 * The Starbase RPC surface — a single source of truth shared by the Electron
 * main process (which implements the handlers as Effect services) and the
 * renderer (which calls them through a typed `RpcClient`). Transport is Electron
 * IPC; serialization is JSON. See `apps/desktop/src/main/rpc` for the wiring.
 */
export class StarbaseRpcs extends RpcGroup.make(
  /** List every known coding CLI and whether it is installed on this host. */
  Rpc.make("Discovery.list", {
    success: Schema.Array(CliInfo),
    error: DiscoveryError
  }),

  /** Read the persisted app config (null `reposDir` means first-run setup is pending). */
  Rpc.make("Config.get", {
    success: Schema.NullOr(WorkspaceConfig)
  }),

  /**
   * Open a native folder picker for the repos directory, persist the choice, and
   * return the updated config. Returns null if the user cancels the dialog.
   */
  Rpc.make("Setup.chooseReposDir", {
    success: Schema.NullOr(WorkspaceConfig)
  }),

  /** Scan the configured repos directory for git repositories. */
  Rpc.make("Workspace.repos", {
    success: Schema.Array(Repo),
    error: WorkspaceNotConfiguredError
  }),

  /** List the local branch names for one repo (for the base-branch picker). */
  Rpc.make("Workspace.branches", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: { repoPath: Schema.String }
  }),

  /** List a repo's tracked files (for the `@` code-reference menu). */
  Rpc.make("Workspace.files", {
    success: Schema.Array(Schema.String),
    error: GitError,
    payload: { repoPath: Schema.String }
  }),

  /** Discard ALL uncommitted changes to a file in a session's worktree. */
  Rpc.make("Workspace.revertFile", {
    error: GitError,
    payload: { sessionId: Schema.String, path: Schema.String }
  }),

  /** Revert just the uncommitted changes in a NEW-file line range (reverse-apply). */
  Rpc.make("Workspace.revertLines", {
    error: GitError,
    payload: {
      sessionId: Schema.String,
      path: Schema.String,
      startLine: Schema.Number,
      endLine: Schema.Number
    }
  }),

  /** List all agent sessions for the sidebar. */
  Rpc.make("Sessions.list", {
    success: Schema.Array(Session)
  }),

  /** Fetch one session by id. */
  Rpc.make("Sessions.get", {
    success: Session,
    error: SessionNotFoundError,
    payload: { id: Schema.String }
  }),

  /** Create a session: fork an isolated git worktree, persist, and return it. */
  Rpc.make("Sessions.create", {
    success: Session,
    error: GitError,
    payload: CreateSessionInput
  }),

  /**
   * Create a session from an existing PR: land a worktree on the PR's head
   * branch (`gh pr checkout`), link `prNumber`, persist, and return it.
   */
  Rpc.make("Sessions.createFromPr", {
    success: Session,
    error: Schema.Union(GitError, GhError),
    payload: CreateSessionFromPrInput
  }),

  /**
   * Create a session from a GitHub issue: fork a fresh `<number>-<slug>` branch
   * off base, link the issue + automations, seed the task from the issue.
   */
  Rpc.make("Sessions.createFromIssue", {
    success: Session,
    error: GitError,
    payload: CreateSessionFromIssueInput
  }),

  /** Link a GitHub issue to a live session (attach flow); returns the updated session. */
  Rpc.make("Sessions.linkIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: {
      sessionId: Schema.String,
      issue: IssueSummary,
      automations: IssueAutomations
    }
  }),

  /** Unlink the session's GitHub issue; returns the updated session. */
  Rpc.make("Sessions.unlinkIssue", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Clear a session's one-shot `initialPrompt` once the composer has consumed
   * it; returns the updated session so the client state stops re-seeding.
   */
  Rpc.make("Sessions.clearInitialPrompt", {
    success: Session,
    error: Schema.Union(GitError, SessionNotFoundError),
    payload: { sessionId: Schema.String }
  }),

  /** Archive a session (its linked PR merged/closed) — read-only, kept. */
  Rpc.make("Sessions.archive", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, reason: ArchiveReason }
  }),

  /** Restore an archived session back to an editable state. */
  Rpc.make("Sessions.restore", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Regenerate an auto-titled session's title from its transcript; returns it. */
  Rpc.make("Sessions.retitle", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Manually rename a session — pins the title (stops auto-retitling). */
  Rpc.make("Sessions.rename", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, title: Schema.String }
  }),

  /**
   * Record a session's lifecycle status when its turn settles. Live activity is
   * renderer-only, but this persists so a session the operator hasn't OPENED this
   * run still reports whether it's idle or blocked on them.
   */
  Rpc.make("Sessions.setStatus", {
    success: Session,
    error: GitError,
    payload: { sessionId: Schema.String, status: SessionStatus }
  }),

  /** Permanently delete a session and remove its worktree. Irreversible. */
  Rpc.make("Sessions.delete", {
    error: GitError,
    payload: { sessionId: Schema.String }
  }),

  /** Load a session's persisted conversation transcript. */
  Rpc.make("Sessions.transcript", {
    success: Schema.Array(Message),
    payload: { id: Schema.String }
  }),

  /** The session worktree's unified working diff, for the Changes rail. */
  Rpc.make("Sessions.diff", {
    success: Schema.String,
    payload: { id: Schema.String }
  }),

  /**
   * Send a prompt and stream the agent's normalized events back. This is the
   * harness-agnostic seam: the renderer folds the same `StreamEvent`s the runner
   * persisted, so the experience is identical across models/harnesses.
   */
  Rpc.make("Agent.run", {
    success: StreamEvent,
    stream: true,
    payload: {
      sessionId: Schema.String,
      text: Schema.String,
      /** Images the operator attached as context (optional; omitted → none). */
      images: Schema.optional(Schema.Array(Attachment))
    }
  }),

  /** Resolve a pending HITL approval gate (allow / deny / always). */
  Rpc.make("Agent.decideGate", {
    payload: {
      sessionId: Schema.String,
      gateId: Schema.String,
      decision: GateDecision
    }
  }),

  /** Submit answers to a pending AskUserQuestion group, resuming the agent. */
  Rpc.make("Agent.answerQuestion", {
    payload: {
      sessionId: Schema.String,
      requestId: Schema.String,
      answers: Schema.Array(QuestionAnswer)
    }
  }),

  /** Change a session's HITL permission mode (ask / accept-edits / auto / plan). */
  Rpc.make("Agent.setMode", {
    payload: { sessionId: Schema.String, mode: PermissionMode }
  }),

  /** Comment on a plan step (plan mode) — accumulates on the plan, doesn't resume. */
  Rpc.make("Agent.commentPlanStep", {
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      stepId: Schema.String,
      body: Schema.String
    }
  }),

  /** Route the plan's open comments back to the agent as a revision, resuming planning. */
  Rpc.make("Agent.revisePlan", {
    payload: { sessionId: Schema.String, planId: Schema.String }
  }),

  /** Approve a plan — restore the exec mode and start execution. */
  Rpc.make("Agent.approvePlan", {
    payload: { sessionId: Schema.String, planId: Schema.String }
  }),

  /**
   * Approve a plan whose original run is gone (stale, e.g. after a restart):
   * re-drive execution as a fresh run (restore the exec mode + prompt with the
   * plan embedded) and stream its events, like `Agent.run`.
   */
  Rpc.make("Agent.resumePlan", {
    success: StreamEvent,
    stream: true,
    payload: { sessionId: Schema.String, planId: Schema.String }
  }),

  /**
   * Change a session's harness and/or model (used on the next turn — a turn
   * already streaming finishes on the old one).
   *
   * Model and harness move together because a model id only means something to
   * the harness that offers it: `opus` is nonsense to Codex. Switching `cli`
   * also drops the session's `resumeId` (a Codex thread id is meaningless to
   * Claude) so the new harness starts a fresh thread.
   */
  Rpc.make("Agent.setHarness", {
    payload: { sessionId: Schema.String, cli: CliKind, model: Schema.String }
  }),

  /** Stop a running agent (denies any pending gate). */
  Rpc.make("Agent.stop", {
    payload: { sessionId: Schema.String }
  }),

  /** List the skills/slash-commands the session's harness exposes (the `/` menu). */
  Rpc.make("Skills.list", {
    success: Schema.Array(Skill),
    payload: { sessionId: Schema.String }
  }),

  /** List the models a harness supports (live from the provider; for the chip). */
  Rpc.make("Models.list", {
    success: Schema.Array(ModelOption),
    payload: { cli: CliKind }
  }),

  /**
   * Every installed harness with its models — the composer's model menu, which
   * lets the user switch provider by picking a model under its section. One
   * round trip instead of one per harness.
   */
  Rpc.make("Models.catalog", {
    success: Schema.Array(ProviderModels)
  }),

  /** Provider usage / rate-limit windows for the Usage & limits modal. */
  Rpc.make("Usage.get", {
    success: Usage
  }),

  /** Detect the GitHub CLI (`gh`) and its authentication status. */
  Rpc.make("Gh.status", {
    success: GhStatus
  }),

  /** Persist the user's GitHub integration preferences. */
  Rpc.make("Config.setGithub", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: GithubConfig
  }),

  /** Persist the user's git behaviour preferences. */
  Rpc.make("Config.setGit", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: GitConfig
  }),

  /** Persist the full set of starred repo paths (replaces the stored list). */
  Rpc.make("Config.setStarredRepos", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { paths: Schema.Array(Schema.String) }
  }),

  /** Persist the full set of collapsed repo paths (replaces the stored list). */
  Rpc.make("Config.setCollapsedRepos", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { paths: Schema.Array(Schema.String) }
  }),

  /** Remember the repo used for the most recent session create (picker default). */
  Rpc.make("Config.setLastRepoPath", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { path: Schema.String }
  }),

  /** Persist one CLI's provider defaults (model, mode, reasoning, …). */
  Rpc.make("Config.setProvider", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { cli: CliKind, provider: ProviderConfig }
  }),

  /**
   * Run an adversarial review of the session's linked PR: a reviewer agent runs
   * READ-ONLY in the session's worktree, on the configured review model (Fable by
   * default), and argues against the diff.
   *
   * De-duped on the PR head SHA — a run whose head matches the stored review
   * returns that review without spawning an agent, unless `force`. That is what
   * lets the auto-review trigger fire off a poll loop safely.
   */
  Rpc.make("Review.run", {
    success: AdversarialReview,
    error: ReviewError,
    payload: { sessionId: Schema.String, force: Schema.Boolean }
  }),

  /**
   * Watch the running reviewer's events for a session — what it has emitted so
   * far, then everything after, live.
   *
   * Separate from `Review.run` (which blocks for the whole multi-minute run and
   * returns only the verdict) because the watcher usually isn't the caller: the
   * auto-review is a poll across every session, so a reviewer may already be
   * mid-flight when you open one. Subscribing is safe at any time — the stream is
   * simply empty until a review starts.
   */
  Rpc.make("Review.watch", {
    success: StreamEvent,
    stream: true,
    payload: { sessionId: Schema.String }
  }),

  /** The last stored adversarial review for a session, or null. Never errors. */
  Rpc.make("Review.get", {
    success: Schema.NullOr(AdversarialReview),
    payload: { sessionId: Schema.String }
  }),

  /**
   * The pull request linked to a session (its `prNumber`), assembled from `gh pr
   * view`. Null when the session has no worktree or no linked PR. Embeds CI
   * checks, reviewers, and the review timeline for the Pull Request tab.
   */
  Rpc.make("Github.pr", {
    success: Schema.NullOr(PullRequest),
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /**
   * List open PRs for a repo (for the "new session from a PR" picker). `mine`
   * filters to the authenticated user; `search` is a free-text query. Never
   * errors — folds to an empty list.
   */
  Rpc.make("Github.listPrs", {
    success: Schema.Array(PrSummary),
    payload: {
      repoPath: Schema.String,
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /**
   * List open issues for a repo (for the "new session from an issue" picker +
   * attach dialog). `mine` filters to issues assigned to you. Never errors —
   * folds to an empty list.
   */
  Rpc.make("Github.listIssues", {
    success: Schema.Array(IssueSummary),
    payload: {
      repoPath: Schema.String,
      mine: Schema.Boolean,
      search: Schema.String
    }
  }),

  /** Close the session's linked issue (close-on-merge automation). */
  Rpc.make("Github.closeIssue", {
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /** The full linked-issue view model for the session's Issue tab (null if none). */
  Rpc.make("Github.issue", {
    success: Schema.NullOr(Issue),
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  /** The lifecycle state of a session's linked PR (for the archive sweep). */
  Rpc.make("Github.prState", {
    success: Schema.NullOr(PrState),
    payload: { sessionId: Schema.String }
  }),

  /** The changed files of a session's PR, for the Code Review file list. */
  Rpc.make("Github.files", {
    success: Schema.Array(PrFileChange),
    payload: { sessionId: Schema.String }
  }),

  /** The unified diff of a session's PR vs its base branch. */
  Rpc.make("Github.diff", {
    success: Schema.String,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Detect a PR already open on the session's branch, link it (persist
   * `prNumber`), and return its number (null if none).
   */
  Rpc.make("Github.detectPr", {
    success: Schema.NullOr(Schema.Number),
    payload: { sessionId: Schema.String }
  }),

  /** Open a PR from the session's branch and link it; returns the PR number. */
  Rpc.make("Github.createPr", {
    success: Schema.Number,
    error: GhError,
    payload: {
      sessionId: Schema.String,
      title: Schema.String,
      body: Schema.String,
      base: Schema.String,
      draft: Schema.Boolean
    }
  }),

  /**
   * Post a top-level comment on the session's PR. `toGithub` gates the actual
   * `gh pr comment` write (the renderer separately routes the body to the agent).
   */
  Rpc.make("Github.comment", {
    error: GhError,
    payload: { sessionId: Schema.String, body: Schema.String, toGithub: Schema.Boolean }
  }),

  /** Submit a review (comment / approve / request-changes) on the session's PR. */
  Rpc.make("Github.review", {
    error: GhError,
    payload: { sessionId: Schema.String, kind: ReviewSubmitKind, body: Schema.String }
  }),

  /**
   * Resolve / unresolve an inline review thread on the session's PR. `threadId`
   * is the GraphQL node id carried on `PrReviewThread.id`.
   */
  Rpc.make("Github.resolveThread", {
    error: GhError,
    payload: { sessionId: Schema.String, threadId: Schema.String, resolved: Schema.Boolean }
  }),

  /**
   * Reply to the inline review thread `commentId` belongs to. `commentId` is the
   * REST numeric id from `PrThreadComment.databaseId` (not the node id).
   */
  Rpc.make("Github.replyToThread", {
    error: GhError,
    payload: { sessionId: Schema.String, commentId: Schema.Number, body: Schema.String }
  }),

  /**
   * Merge the session's linked PR. `method` defaults to a merge commit; surfaces
   * `GhError` when GitHub rejects the merge (branch protection, conflicts, …).
   */
  Rpc.make("Github.merge", {
    error: GhError,
    payload: { sessionId: Schema.String, method: Schema.optional(PrMergeMethod) }
  }),

  /**
   * Flip the session's draft PR to "ready for review" (`gh pr ready`); surfaces
   * `GhError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.markReady", {
    error: GhError,
    payload: { sessionId: Schema.String }
  }),

  // ── Terminal ───────────────────────────────────────────────────────────────
  // A native PTY-backed terminal, scoped to a session (cwd = its worktree). The
  // PTY lives in the main process; only coalesced byte frames cross IPC. Lifecycle
  // (create/resize/kill/list) is unary; the hot output path is the `attach` stream.

  /**
   * Spawn a login shell in `cwd` (defaults to the session's worktree) sized to
   * `cols`×`rows`, and return its descriptor. The PTY outlives dock toggles and
   * session switches — it is only reclaimed by `Terminal.kill`, session delete,
   * or app quit.
   */
  Rpc.make("Terminal.create", {
    success: TerminalInfo,
    error: TerminalError,
    payload: {
      sessionId: Schema.String,
      cwd: Schema.optional(Schema.String),
      cols: Schema.Number,
      rows: Schema.Number
    }
  }),

  /**
   * Subscribe to a terminal's output. Replays the recent scrollback (a bounded
   * ring buffer) so a re-attach after a dock/session toggle restores the screen,
   * then streams live *coalesced* frames. Long-lived: cancel the stream to
   * detach (the PTY keeps running). Ends with an `exit` frame when the shell dies.
   */
  Rpc.make("Terminal.attach", {
    success: TerminalChunk,
    stream: true,
    payload: { terminalId: Schema.String }
  }),

  /** Write operator keystrokes (or pasted text) to a terminal's PTY. No-op if unknown. */
  Rpc.make("Terminal.write", {
    payload: { terminalId: Schema.String, data: Schema.String }
  }),

  /** Resize a terminal's PTY (drives SIGWINCH so TUIs reflow). No-op if unknown. */
  Rpc.make("Terminal.resize", {
    payload: { terminalId: Schema.String, cols: Schema.Number, rows: Schema.Number }
  }),

  /** Kill a terminal's shell (SIGHUP) and drop it. Idempotent. */
  Rpc.make("Terminal.kill", {
    payload: { terminalId: Schema.String }
  }),

  /** List the live terminals for a session (to rebuild its tab strip on mount). */
  Rpc.make("Terminal.list", {
    success: Schema.Array(TerminalInfo),
    payload: { sessionId: Schema.String }
  }),

  // ── Auth ─────────────────────────────────────────────────────────────────────
  // The desktop app is gated behind a BetterAuth sign-in wall. The bearer token
  // lives in the OS keychain (main process); these procedures let the renderer
  // read the session, kick off sign-in, and sign out.

  /** The current authenticated session, or null when signed out. */
  Rpc.make("Auth.getSession", {
    success: Schema.NullOr(AuthSession)
  }),

  /**
   * Begin an OAuth sign-in: returns the provider URL the renderer opens in the
   * system browser. The flow completes via the `starbase://` deep link.
   */
  Rpc.make("Auth.startSignIn", {
    success: Schema.String,
    error: AuthError,
    payload: { provider: AuthProvider }
  }),

  /**
   * Request an email magic link (sent by the server; console-logged in dev).
   * `name` is supplied only from the sign-up form; on first sign-in the server
   * uses it as the new user's display name (ignored for existing users).
   */
  Rpc.make("Auth.sendMagicLink", {
    error: AuthError,
    payload: { email: Schema.String, name: Schema.optional(Schema.String) }
  }),

  /** Sign out — revoke on the server (best effort) and clear the local token. */
  Rpc.make("Auth.signOut", {}),

  // ── Browser preview ──────────────────────────────────────────────────────────
  // An embedded `WebContentsView` (main process) pointed at a localhost dev
  // server. It renders OUTSIDE the renderer's DOM/CSP, so the renderer drives it
  // through these procedures and streams the pane's on-screen bounds to keep the
  // native view aligned. There is one preview view (the single window).

  /**
   * Show the preview view and load `url` at `bounds`. Only http/https URLs are
   * accepted (fails with `BrowserPreviewError` otherwise). Idempotent — reuses
   * the existing view if already open.
   */
  Rpc.make("BrowserPreview.open", {
    error: BrowserPreviewError,
    payload: { url: Schema.String, bounds: BrowserBounds }
  }),

  /** Reposition/resize the view to track the pane's rect (on layout/scroll). No-op if closed. */
  Rpc.make("BrowserPreview.setBounds", {
    payload: { bounds: BrowserBounds }
  }),

  /** Navigate the open view to a new URL. Fails with `BrowserPreviewError` for non-http(s). */
  Rpc.make("BrowserPreview.navigate", {
    error: BrowserPreviewError,
    payload: { url: Schema.String }
  }),

  /** Reload the current page. No-op if closed. */
  Rpc.make("BrowserPreview.reload", {}),

  /** Hide + destroy the view (pane closed or session switched). Idempotent. */
  Rpc.make("BrowserPreview.close", {})
) {}
