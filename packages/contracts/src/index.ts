import {
  CliInfo,
  CliKind,
  CreateSessionInput,
  GateDecision,
  GhStatus,
  GithubConfig,
  Message,
  ModelOption,
  PermissionMode,
  PrFileChange,
  PullRequest,
  Repo,
  ReviewSubmitKind,
  Session,
  Skill,
  StreamEvent,
  Usage,
  WorkspaceConfig
} from "@starbase/core"
import {
  ConfigError,
  DiscoveryError,
  GhError,
  GitError,
  SessionNotFoundError,
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
    payload: { sessionId: Schema.String, text: Schema.String }
  }),

  /** Resolve a pending HITL approval gate (allow / deny / always). */
  Rpc.make("Agent.decideGate", {
    payload: {
      sessionId: Schema.String,
      gateId: Schema.String,
      decision: GateDecision
    }
  }),

  /** Change a session's HITL permission mode (ask / accept-edits / auto). */
  Rpc.make("Agent.setMode", {
    payload: { sessionId: Schema.String, mode: PermissionMode }
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
  })
) {}
