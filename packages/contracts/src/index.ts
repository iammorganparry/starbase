import {
  AdversarialReview,
  PlanError,
  HarnessBilling,
  PlanningReadiness,
  PlanRound,
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
  GigaplanRoutingConfig,
  GitConfig,
  GithubConfig,
  NotificationKind,
  NotificationsConfig,
  Issue,
  IssueAutomations,
  IssueSummary,
  ContextConfig,
  ContextSnapshot,
  Message,
  ModelOption,
  OpencodeProviderInfo,
  ExecutionMode,
  PermissionMode,
  PrFileChange,
  McpServer,
  McpServerStatus,
  PrMergeMethod,
  BackgroundTask,
  PrState,
  SessionPrStatus,
  PrSummary,
  ProviderConfig,
  ProviderModels,
  PullRequest,
  QuestionAnswer,
  Repo,
  ReviewComment,
  ReviewSubmitKind,
  Session,
  SettledSessionStatus,
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
  /**
   * What each installed harness will actually be billed to.
   *
   * Read-only and cheap. Exists because the failure it reports was silent: an
   * exported API key overriding a paid subscription, with nothing on screen to
   * say so.
   */
  Rpc.make("Billing.paths", {
    success: Schema.Array(HarnessBilling)
  }),

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
    payload: { sessionId: Schema.String, status: SettledSessionStatus }
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
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      executionMode: Schema.optional(ExecutionMode)
    }
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

  /**
   * List the MCP servers the harness will load. `sessionId` resolves the harness
   * and worktree (so project/local scope is included); pass it null from Settings,
   * which has no session and therefore sees user scope only.
   */
  Rpc.make("Mcp.list", {
    success: Schema.Array(McpServer),
    payload: { sessionId: Schema.NullOr(Schema.String), cli: Schema.optional(CliKind) }
  }),

  /**
   * Live status for those servers — the real MCP handshake, not just "configured".
   * Cached per server; `refresh` forces a re-probe (the dialog's refresh button).
   */
  Rpc.make("Mcp.status", {
    success: Schema.Array(McpServerStatus),
    payload: {
      sessionId: Schema.NullOr(Schema.String),
      cli: Schema.optional(CliKind),
      refresh: Schema.optional(Schema.Boolean)
    }
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

  /**
   * The providers opencode resolves for the user, and where each credential came
   * from — Settings · Providers. Live from the binary, because the answer is a
   * property of the USER's setup (env vars, `opencode auth login`,
   * `opencode.json`), not of Starbase.
   */
  Rpc.make("Opencode.listProviders", {
    success: Schema.Array(OpencodeProviderInfo),
    error: ConfigError
  }),

  /**
   * Store an API key for one opencode provider (e.g. `openrouter`).
   *
   * Writes to opencode's OWN credential file, exactly as `opencode auth login`
   * would — NOT to Starbase's `SecretStore`, which stays reserved for the
   * Starbase bearer token. A key added here therefore works in a bare `opencode`
   * shell too. Succeeds silently into `false` rather than erroring on a bad key:
   * opencode doesn't validate on write.
   */
  Rpc.make("Opencode.setAuth", {
    success: Schema.Boolean,
    error: ConfigError,
    payload: { providerId: Schema.String, key: Schema.String }
  }),

  /** Provider usage / rate-limit windows for the Usage & limits modal. */
  Rpc.make("Usage.get", {
    success: Usage
  }),

  /**
   * A session's context accounting — what the meter renders and what Settings
   * lists. Cheap enough to poll: it reads in-memory state plus the persisted
   * session, and never touches a harness.
   */
  Rpc.make("Context.state", {
    success: ContextSnapshot,
    payload: { sessionId: Schema.String }
  }),

  /**
   * Compact this session now, regardless of the budget.
   *
   * Returns immediately — the digest is built on a background fiber, exactly as
   * an automatic compaction would be, and lands on the NEXT turn. A button that
   * blocked until the summary was ready would reintroduce the wait the whole
   * feature exists to remove.
   */
  Rpc.make("Context.compactNow", {
    payload: { sessionId: Schema.String }
  }),

  /** Persist the auto-compaction levers (master switch + working-set budget). */
  Rpc.make("Config.setContext", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: ContextConfig
  }),

  /** Per-session auto-compaction override (absent = follow the global setting). */
  Rpc.make("Sessions.setAutoCompact", {
    success: Session,
    error: GitError,
    payload: { id: Schema.String, autoCompact: Schema.NullOr(Schema.Boolean) }
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

  /** Persist the user's desktop-notification preferences. */
  Rpc.make("Config.setNotifications", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: NotificationsConfig
  }),

  /**
   * Persist whether plan mode runs commands unattended. Plan mode cannot edit,
   * so this only ever covers read-only commands.
   */
  Rpc.make("Config.setPlanAutoRun", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ planAutoRun: Schema.Boolean })
  }),

  /**
   * Persist ADHD mode — whether every agent turn is asked to shape its reply
   * for an ADHD reader. Returns the whole config so the renderer can patch its
   * cache without a refetch.
   */
  Rpc.make("Config.setAdhdMode", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ adhdMode: Schema.Boolean })
  }),

  /**
   * Persist which harness NEW sessions start on. One standing answer, set in
   * Settings · Providers, in place of the New Session dialog's old select.
   */
  Rpc.make("Config.setDefaultCli", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: Schema.Struct({ cli: CliKind })
  }),

  /**
   * Raise an OS notification for a session.
   *
   * Main owns the Electron `Notification` API, but only the RENDERER knows
   * whether this session is the one the operator is already looking at — so the
   * decision to notify is made there and this call is the delivery mechanism.
   * Deliberately fire-and-forget: a notification that fails to show must never
   * disturb the run that triggered it.
   */
  Rpc.make("Notify.show", {
    success: Schema.Void,
    payload: {
      sessionId: Schema.String,
      kind: NotificationKind,
      title: Schema.String,
      body: Schema.String,
      /**
       * Is this the session the operator currently has open? Only the renderer
       * knows; main pairs it with the window's own focus state (which only main
       * knows authoritatively) to decide whether the operator can already see
       * what we're about to tell them.
       */
      isActiveSession: Schema.Boolean
    }
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
  /** Turn learning from finished work on or off. Absent config ⇒ off. */
  /**
   * Which harness+model Gigaplan itself runs on.
   *
   * One fixed model rather than a per-message choice — the intelligence this
   * feature is for is spent choosing a model per PLAN STEP, which is the only
   * place the right answer varies.
   */
  Rpc.make("Config.setOrchestrator", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { cli: CliKind, model: Schema.String }
  }),

  Rpc.make("Config.setGigaplanRouting", {
    success: WorkspaceConfig,
    error: ConfigError,
    payload: { routing: GigaplanRoutingConfig }
  }),

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
  /**
   * Run an adversarial planning round: one flagship proposes a plan, a model
   * from a DIFFERENT lab attacks it, and the proposer answers.
   *
   * Streams rather than returning the plan, because the three phases take
   * minutes between them and each runs as a surfaced sub-agent — so the operator
   * watches "proposing / attacking / revising" happen instead of staring at one
   * spinner. The settled plan arrives as a `PlanProposed` event and folds into
   * the transcript through the same path a single-agent plan does.
   */
  Rpc.make("Plan.adversarial", {
    success: StreamEvent,
    stream: true,
    error: PlanError,
    payload: {
      sessionId: Schema.String,
      brief: Schema.String,
      /**
       * Screenshots attached to the brief (optional; omitted → none).
       *
       * A brief is very often "make it look like this" — the round used to have
       * no image channel at all, so the composer had to refuse attachments in
       * Gigaplan mode. Every role sees them, because a critic judging a plan
       * drawn from a screenshot it cannot see is judging the wrong thing.
       */
      images: Schema.optional(Schema.Array(Attachment))
    }
  }),

  /**
   * The last planning round for a session, or null — the audit trail behind a
   * plan, holding the pre-revision proposal beside the critique. Never errors:
   * a missing or stale round costs an unavailable audit trail, not a broken tab.
   */
  Rpc.make("Plan.round", {
    success: Schema.NullOr(PlanRound),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Whether adversarial planning is worth offering here, and if not, what would
   * fix it.
   *
   * The renderer needs the REASON, not just a boolean: the entry is rendered
   * disabled with an explanation rather than hidden, so a user with one provider
   * learns why and what to install instead of never discovering the feature.
   */
  Rpc.make("Plan.readiness", {
    success: PlanningReadiness,
    payload: {}
  }),

  /**
   * Run an approved plan, step by step, each on the harness it was assigned.
   *
   * A stream for the same reason `Agent.run` is: the operator watches steps go
   * past as subagents. Takes only the plan's ID — main reads the artifact back
   * from the session's transcript, because the renderer's copy may have been
   * edited on screen and executing anything other than what was approved would
   * make the audit trail a lie.
   */
  Rpc.make("Plan.execute", {
    success: StreamEvent,
    error: PlanError,
    payload: {
      sessionId: Schema.String,
      planId: Schema.String,
      executionMode: Schema.optional(ExecutionMode)
    },
    stream: true
  }),

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
   * Stamp the stored review as having had its critical/major findings handed to
   * the session's agent, returning the stamp (ISO-8601).
   *
   * The renderer owns the routing itself — the conversation actor lives there,
   * and routing through it is what puts the agent's work and its approval gates
   * in the Conversation tab instead of a hidden run. But it cannot own the
   * MEMORY of having routed: `routed-store` is in-memory, so after a reload the
   * auto-review poll would hand back the same review and re-send the whole batch
   * as a fresh turn. So the renderer acts, and asks main to remember.
   *
   * A no-op (returning the existing stamp) when the review is already routed, so
   * a double-call from a re-render can't move the goalposts.
   */
  Rpc.make("Review.markRouted", {
    success: Schema.NullOr(Schema.String),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Attribute any outstanding findings to the commits that fixed them, and
   * return the updated review — or **null when nothing changed**.
   *
   * Null-on-no-change is the contract, not an accident: the renderer calls this
   * every time a turn settles, and the overwhelmingly common answer is "no new
   * commits touched a finding's file". Returning the unchanged review would have
   * the renderer publish an identical object into the query cache on every turn,
   * re-rendering the review pane for nothing. Null also covers "no stored review"
   * and "no worktree", which need the same treatment: leave the cache alone.
   */
  Rpc.make("Review.reconcile", {
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

  /**
   * A session's linked PR reduced to what the sidebar row shows — its lifecycle
   * state plus a CI rollup. Polled per session on a timer, so it is deliberately
   * the cheapest PR read in the contract; `Github.pullRequest` is the rich one.
   */
  Rpc.make("Github.prState", {
    success: Schema.NullOr(SessionPrStatus),
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

  /**
   * Submit the reviewer's drafts to the session's PR as a COMMENT review
   * carrying real, line-anchored inline comments.
   *
   * Distinct from `Github.comment` (one top-level blob) and `Github.review` (a
   * body and nothing else): this is the only path that produces inline threads,
   * so a comment written in Starbase comes back from GitHub on the same line.
   *
   * Returns how many drafts couldn't be anchored to a line in the PR's current
   * diff — those are folded into the review body rather than dropped, so a
   * non-zero count is informational, not a failure.
   */
  Rpc.make("Github.submitReview", {
    success: Schema.Number,
    error: GhError,
    payload: { sessionId: Schema.String, comments: Schema.Array(ReviewComment) }
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

  /**
   * Merge the base branch into the PR's head — GitHub's "Update branch", the fix
   * for a `BEHIND` merge state. Updates the REMOTE head only; the session's
   * worktree is deliberately left alone, since the agent may be mid-turn.
   * Surfaces `GhError` when there is no linked PR or GitHub rejects it.
   */
  Rpc.make("Github.updateBranch", {
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

  // ── Background tasks ─────────────────────────────────────────────────────────
  // Harness work that OUTLIVES the turn that started it. Lives in a main-process
  // registry (one statechart per task) rather than in per-run renderer state,
  // which is cleared on every new turn.

  /**
   * A session's background tasks — running first, then settled ones (whose
   * transcripts are still worth reading). Rebuilds the dock on mount.
   */
  Rpc.make("BackgroundTasks.list", {
    success: Schema.Array(BackgroundTask),
    payload: { sessionId: Schema.String }
  }),

  /**
   * Ask the harness to stop one task, returning it in its new state — normally
   * `stopping`, since confirmation arrives later, or a terminal state when no
   * live harness owns it. Null when the id is unknown. Idempotent.
   */
  Rpc.make("BackgroundTasks.stop", {
    success: Schema.NullOr(BackgroundTask),
    payload: { sessionId: Schema.String, taskId: Schema.String }
  }),

  /**
   * Drop a settled task's row. Settled tasks normally age out on their own after
   * a short grace period; a FAILED one is held indefinitely so an error can't
   * scroll past unseen, and this is how the operator clears it. Idempotent — an
   * unknown id (already aged out, already dismissed) succeeds silently.
   */
  Rpc.make("BackgroundTasks.dismiss", {
    success: Schema.Void,
    payload: { sessionId: Schema.String, taskId: Schema.String }
  }),

  /**
   * A settled task's full transcript, read from the `output_file` the harness
   * reported. Empty while the task is still running — there is no output stream
   * before it settles, only the progress fields on the task itself.
   */
  Rpc.make("BackgroundTasks.output", {
    success: Schema.String,
    payload: { sessionId: Schema.String, taskId: Schema.String }
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
