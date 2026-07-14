import {
  ArchiveReason,
  Attachment,
  CliInfo,
  CliKind,
  CreateSessionFromPrInput,
  CreateSessionInput,
  GateDecision,
  GhStatus,
  GitConfig,
  GithubConfig,
  Message,
  ModelOption,
  PermissionMode,
  PrFileChange,
  PrMergeMethod,
  PrState,
  PrSummary,
  ProviderConfig,
  PullRequest,
  QuestionAnswer,
  Repo,
  ReviewSubmitKind,
  Session,
  Skill,
  StreamEvent,
  TerminalChunk,
  TerminalInfo,
  Usage,
  WorkspaceConfig
} from "@starbase/core"
import {
  ConfigError,
  DiscoveryError,
  GhError,
  GitError,
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

  /** Change a session's harness model (used on the next turn). */
  Rpc.make("Agent.setModel", {
    payload: { sessionId: Schema.String, model: Schema.String }
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
   * Merge the session's linked PR. `method` defaults to a merge commit; surfaces
   * `GhError` when GitHub rejects the merge (branch protection, conflicts, …).
   */
  Rpc.make("Github.merge", {
    error: GhError,
    payload: { sessionId: Schema.String, method: Schema.optional(PrMergeMethod) }
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
  })
) {}
