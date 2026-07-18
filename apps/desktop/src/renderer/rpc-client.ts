/**
 * Renderer-side RPC client. Mirror image of `src/main/rpc.ts`: a custom
 * `RpcClient.Protocol` that shuttles encoded frames over the preload bridge
 * (`window.starbase`), driving a real `RpcClient` built from the shared
 * `StarbaseRpcs` group. Callers get plain, typed Promises back.
 */
import type {
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
  McpServer,
  McpServerStatus,
  Message,
  ModelOption,
  OpencodeProviderInfo,
  ProviderModels,
  PermissionMode,
  PrFileChange,
  PrMergeMethod,
  PrState,
  PrSummary,
  ProviderConfig,
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
import { StarbaseRpcs } from "@starbase/contracts"
import { RpcClient } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Fiber, Layer, ManagedRuntime, Runtime, Scope, Stream } from "effect"

/**
 * A custom `RpcClient.Protocol` bound to the preload bridge. `send` ships a
 * client→server frame to main; incoming server→client frames are pushed into
 * the client core via `writeResponse`.
 */
const ClientProtocolLive = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

      window.starbase.on((data) => {
        runFork(writeResponse(data as FromServerEncoded))
      })

      return {
        send: (request: FromClientEncoded) =>
          Effect.sync(() => window.starbase.send(request)),
        supportsAck: true,
        supportsTransferables: false
      }
    })
  )
)

/** One runtime provides the IPC client protocol for the app's lifetime. */
const runtime = ManagedRuntime.make(ClientProtocolLive)

/**
 * The client's background fibers must outlive any single call, so we build it
 * once inside a scope that is never closed (until the page unloads).
 */
const clientScope = Effect.runSync(Scope.make())

const clientPromise = runtime.runPromise(
  RpcClient.make(StarbaseRpcs).pipe(Scope.extend(clientScope))
)

const run = <A>(
  f: (client: Awaited<typeof clientPromise>) => Effect.Effect<A, unknown>
): Promise<A> => clientPromise.then((client) => runtime.runPromise(f(client)))

/** The typed calls the renderer consumes. */
export const rpc = {
  discoveryList: (): Promise<ReadonlyArray<CliInfo>> =>
    run((c) => c.Discovery.list()),
  configGet: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Config.get()),
  chooseReposDir: (): Promise<WorkspaceConfig | null> =>
    run((c) => c.Setup.chooseReposDir()),
  workspaceRepos: (): Promise<ReadonlyArray<Repo>> =>
    run((c) => c.Workspace.repos()),
  workspaceBranches: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.branches({ repoPath })),
  ghStatus: (): Promise<GhStatus> =>
    run((c) => c.Gh.status()),
  sessionsList: (): Promise<ReadonlyArray<Session>> =>
    run((c) => c.Sessions.list()),
  sessionsGet: (id: string): Promise<Session> =>
    run((c) => c.Sessions.get({ id })),
  sessionsCreate: (input: CreateSessionInput): Promise<Session> =>
    run((c) => c.Sessions.create(input)),
  sessionsCreateFromPr: (input: CreateSessionFromPrInput): Promise<Session> =>
    run((c) => c.Sessions.createFromPr(input)),
  sessionsCreateFromIssue: (input: CreateSessionFromIssueInput): Promise<Session> =>
    run((c) => c.Sessions.createFromIssue(input)),
  sessionsLinkIssue: (
    sessionId: string,
    issue: IssueSummary,
    automations: IssueAutomations
  ): Promise<Session> => run((c) => c.Sessions.linkIssue({ sessionId, issue, automations })),
  sessionsUnlinkIssue: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.unlinkIssue({ sessionId })),
  sessionsClearInitialPrompt: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.clearInitialPrompt({ sessionId })),
  sessionsArchive: (sessionId: string, reason: ArchiveReason): Promise<Session> =>
    run((c) => c.Sessions.archive({ sessionId, reason })),
  sessionsRestore: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.restore({ sessionId })),
  sessionsRetitle: (sessionId: string): Promise<Session> =>
    run((c) => c.Sessions.retitle({ sessionId })),
  sessionsRename: (sessionId: string, title: string): Promise<Session> =>
    run((c) => c.Sessions.rename({ sessionId, title })),
  sessionsSetStatus: (sessionId: string, status: SettledSessionStatus): Promise<Session> =>
    run((c) => c.Sessions.setStatus({ sessionId, status })),
  sessionsDelete: (sessionId: string): Promise<void> =>
    run((c) => c.Sessions.delete({ sessionId })),
  sessionsTranscript: (id: string): Promise<ReadonlyArray<Message>> =>
    run((c) => c.Sessions.transcript({ id })),
  sessionsDiff: (id: string): Promise<string> => run((c) => c.Sessions.diff({ id })),
  workspaceFiles: (repoPath: string): Promise<ReadonlyArray<string>> =>
    run((c) => c.Workspace.files({ repoPath })),
  workspaceRevertFile: (sessionId: string, path: string): Promise<void> =>
    run((c) => c.Workspace.revertFile({ sessionId, path })),
  workspaceRevertLines: (
    sessionId: string,
    path: string,
    startLine: number,
    endLine: number
  ): Promise<void> => run((c) => c.Workspace.revertLines({ sessionId, path, startLine, endLine })),
  skillsList: (sessionId: string): Promise<ReadonlyArray<Skill>> =>
    run((c) => c.Skills.list({ sessionId })),
  /**
   * MCP servers the harness will load. Pass a `sessionId` to include the session's
   * project/local scope; pass null + `cli` from Settings, which has no worktree and
   * therefore sees user scope only.
   */
  mcpList: (sessionId: string | null, cli?: CliKind): Promise<ReadonlyArray<McpServer>> =>
    run((c) => c.Mcp.list({ sessionId, cli })),
  /** Live probe of those servers. `refresh` bypasses the cache (the dialog's refresh). */
  mcpStatus: (
    sessionId: string | null,
    cli?: CliKind,
    refresh?: boolean
  ): Promise<ReadonlyArray<McpServerStatus>> => run((c) => c.Mcp.status({ sessionId, cli, refresh })),
  modelsList: (cli: CliKind): Promise<ReadonlyArray<ModelOption>> =>
    run((c) => c.Models.list({ cli })),
  modelsCatalog: (): Promise<ReadonlyArray<ProviderModels>> => run((c) => c.Models.catalog()),
  /** opencode's resolved providers + where each credential came from. */
  opencodeListProviders: (): Promise<ReadonlyArray<OpencodeProviderInfo>> =>
    run((c) => c.Opencode.listProviders()),
  /** Store an API key in opencode's OWN credential file (not SecretStore). */
  opencodeSetAuth: (providerId: string, key: string): Promise<boolean> =>
    run((c) => c.Opencode.setAuth({ providerId, key })),
  usageGet: (): Promise<Usage> => run((c) => c.Usage.get()),
  agentDecideGate: (sessionId: string, gateId: string, decision: GateDecision): Promise<void> =>
    run((c) => c.Agent.decideGate({ sessionId, gateId, decision })),
  agentAnswerQuestion: (
    sessionId: string,
    requestId: string,
    answers: ReadonlyArray<QuestionAnswer>
  ): Promise<void> => run((c) => c.Agent.answerQuestion({ sessionId, requestId, answers })),
  agentSetMode: (sessionId: string, mode: PermissionMode): Promise<void> =>
    run((c) => c.Agent.setMode({ sessionId, mode })),
  agentCommentPlanStep: (sessionId: string, planId: string, stepId: string, body: string): Promise<void> =>
    run((c) => c.Agent.commentPlanStep({ sessionId, planId, stepId, body })),
  agentRevisePlan: (sessionId: string, planId: string): Promise<void> =>
    run((c) => c.Agent.revisePlan({ sessionId, planId })),
  agentApprovePlan: (sessionId: string, planId: string): Promise<void> =>
    run((c) => c.Agent.approvePlan({ sessionId, planId })),
  agentSetHarness: (sessionId: string, cli: CliKind, model: string): Promise<void> =>
    run((c) => c.Agent.setHarness({ sessionId, cli, model })),
  agentStop: (sessionId: string): Promise<void> => run((c) => c.Agent.stop({ sessionId })),

  configSetGithub: (github: GithubConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setGithub(github)),
  configSetGit: (git: GitConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setGit(git)),
  configSetStarredRepos: (paths: ReadonlyArray<string>): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setStarredRepos({ paths })),
  configSetCollapsedRepos: (paths: ReadonlyArray<string>): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setCollapsedRepos({ paths })),
  configSetLastRepoPath: (path: string): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setLastRepoPath({ path })),
  configSetProvider: (cli: CliKind, provider: ProviderConfig): Promise<WorkspaceConfig> =>
    run((c) => c.Config.setProvider({ cli, provider })),
  githubPr: (sessionId: string): Promise<PullRequest | null> =>
    run((c) => c.Github.pr({ sessionId })),
  githubPrState: (sessionId: string): Promise<PrState | null> =>
    run((c) => c.Github.prState({ sessionId })),
  githubListPrs: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ): Promise<ReadonlyArray<PrSummary>> =>
    run((c) => c.Github.listPrs({ repoPath, mine: opts.mine, search: opts.search })),
  githubListIssues: (
    repoPath: string,
    opts: { mine: boolean; search: string }
  ): Promise<ReadonlyArray<IssueSummary>> =>
    run((c) => c.Github.listIssues({ repoPath, mine: opts.mine, search: opts.search })),
  githubCloseIssue: (sessionId: string): Promise<void> =>
    run((c) => c.Github.closeIssue({ sessionId })),
  githubIssue: (sessionId: string): Promise<Issue | null> =>
    run((c) => c.Github.issue({ sessionId })),
  githubFiles: (sessionId: string): Promise<ReadonlyArray<PrFileChange>> =>
    run((c) => c.Github.files({ sessionId })),
  githubDiff: (sessionId: string): Promise<string> =>
    run((c) => c.Github.diff({ sessionId })),
  githubDetectPr: (sessionId: string): Promise<number | null> =>
    run((c) => c.Github.detectPr({ sessionId })),
  /**
   * Run an adversarial review of the session's PR. Cheap and safe to call
   * speculatively: the main process short-circuits on an unchanged PR head, so
   * only `force` guarantees a fresh agent run.
   */
  reviewRun: (sessionId: string, force = false): Promise<AdversarialReview> =>
    run((c) => c.Review.run({ sessionId, force })),
  reviewGet: (sessionId: string): Promise<AdversarialReview | null> =>
    run((c) => c.Review.get({ sessionId })),
  /**
   * Record that the stored review's critical/major findings reached the agent.
   * Returns the stamp, or null when there was no stored review to stamp.
   */
  reviewMarkRouted: (sessionId: string): Promise<string | null> =>
    run((c) => c.Review.markRouted({ sessionId })),
  githubCreatePr: (input: {
    sessionId: string
    title: string
    body: string
    base: string
    draft: boolean
  }): Promise<number> => run((c) => c.Github.createPr(input)),
  githubComment: (sessionId: string, body: string, toGithub: boolean): Promise<void> =>
    run((c) => c.Github.comment({ sessionId, body, toGithub })),
  githubReview: (sessionId: string, kind: ReviewSubmitKind, body: string): Promise<void> =>
    run((c) => c.Github.review({ sessionId, kind, body })),
  /**
   * Post the reviewer's drafts to the PR as line-anchored inline comments.
   * Resolves to the number that couldn't be anchored (folded into the review
   * body instead) — 0 when everything landed on a line.
   */
  githubSubmitReview: (
    sessionId: string,
    comments: ReadonlyArray<ReviewComment>
  ): Promise<number> => run((c) => c.Github.submitReview({ sessionId, comments })),
  githubResolveThread: (sessionId: string, threadId: string, resolved: boolean): Promise<void> =>
    run((c) => c.Github.resolveThread({ sessionId, threadId, resolved })),
  githubReplyToThread: (sessionId: string, commentId: number, body: string): Promise<void> =>
    run((c) => c.Github.replyToThread({ sessionId, commentId, body })),
  githubMerge: (sessionId: string, method?: PrMergeMethod): Promise<void> =>
    run((c) => c.Github.merge({ sessionId, method })),
  githubMarkReady: (sessionId: string): Promise<void> =>
    run((c) => c.Github.markReady({ sessionId })),

  /**
   * Subscribe to a prompt's normalized event stream. Forks the RPC stream on the
   * client runtime, pushing each `StreamEvent` to `onEvent`; returns a canceller
   * that interrupts the run (used on unmount / session switch / stop).
   */
  agentRun: (
    sessionId: string,
    text: string,
    onEvent: (event: StreamEvent) => void,
    images: ReadonlyArray<Attachment> = []
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Agent.run({ sessionId, text, images }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },
  agentResumePlan: (
    sessionId: string,
    planId: string,
    onEvent: (event: StreamEvent) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Agent.resumePlan({ sessionId, planId }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  // ── Terminal ─────────────────────────────────────────────────────────────
  /** Spawn a PTY for a session (cwd defaults to its worktree) and return it. */
  terminalCreate: (
    sessionId: string,
    cwd: string | undefined,
    cols: number,
    rows: number
  ): Promise<TerminalInfo> => run((c) => c.Terminal.create({ sessionId, cwd, cols, rows })),
  /** Send keystrokes / pasted text to a terminal (fire-and-forget). */
  terminalWrite: (terminalId: string, data: string): Promise<void> =>
    run((c) => c.Terminal.write({ terminalId, data })),
  /** Resize a terminal's PTY (drives SIGWINCH). */
  terminalResize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    run((c) => c.Terminal.resize({ terminalId, cols, rows })),
  /** Kill a terminal's shell and drop it. */
  terminalKill: (terminalId: string): Promise<void> =>
    run((c) => c.Terminal.kill({ terminalId })),
  /** List a session's live terminals (rebuild the tab strip on mount). */
  terminalList: (sessionId: string): Promise<ReadonlyArray<TerminalInfo>> =>
    run((c) => c.Terminal.list({ sessionId })),

  // ── Browser preview ────────────────────────────────────────────────────────
  /** Show the preview view and load `url` at `bounds` (rejects non-http(s)). */
  browserPreviewOpen: (url: string, bounds: BrowserBounds): Promise<void> =>
    run((c) => c.BrowserPreview.open({ url, bounds })),
  /** Keep the native view aligned with the pane's on-screen rect. */
  browserPreviewSetBounds: (bounds: BrowserBounds): Promise<void> =>
    run((c) => c.BrowserPreview.setBounds({ bounds })),
  /** Navigate the open preview to a new URL (rejects non-http(s)). */
  browserPreviewNavigate: (url: string): Promise<void> =>
    run((c) => c.BrowserPreview.navigate({ url })),
  /** Reload the current preview page. */
  browserPreviewReload: (): Promise<void> => run((c) => c.BrowserPreview.reload()),
  /** Hide + destroy the preview view (pane closed / session switched). */
  browserPreviewClose: (): Promise<void> => run((c) => c.BrowserPreview.close()),

  // ── Auth ─────────────────────────────────────────────────────────────────
  /** The current authenticated session, or null when signed out. */
  authGetSession: (): Promise<AuthSession | null> => run((c) => c.Auth.getSession()),
  /** Begin OAuth sign-in — returns the URL to open in the system browser. */
  authStartSignIn: (provider: AuthProvider): Promise<string> =>
    run((c) => c.Auth.startSignIn({ provider })),
  /** Request an email magic link. `name` is set only from the sign-up form. */
  authSendMagicLink: (email: string, name?: string): Promise<void> =>
    run((c) => c.Auth.sendMagicLink({ email, name })),
  /** Sign out — revoke on the server and clear the local token. */
  authSignOut: (): Promise<void> => run((c) => c.Auth.signOut()),

  /**
   * Subscribe to a terminal's coalesced output. Mirrors `agentRun`: forks the
   * RPC stream and pushes each `TerminalChunk` to `onChunk`; returns a canceller
   * that detaches (interrupts the fiber) WITHOUT killing the PTY — used on
   * unmount / dock-hide / session switch.
   */
  /**
   * Subscribe to the running reviewer's events for a session. Safe to call when
   * nothing is running — it just stays quiet until a review starts. Returns the
   * unsubscribe.
   */
  reviewWatch: (sessionId: string, onEvent: (event: StreamEvent) => void): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Review.watch({ sessionId }).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  },

  terminalAttach: (
    terminalId: string,
    onChunk: (chunk: TerminalChunk) => void
  ): (() => void) => {
    let fiber: Fiber.RuntimeFiber<void, unknown> | null = null
    let cancelled = false
    void clientPromise.then((client) => {
      if (cancelled) return
      fiber = runtime.runFork(
        client.Terminal.attach({ terminalId }).pipe(
          Stream.runForEach((chunk) => Effect.sync(() => onChunk(chunk)))
        )
      )
    })
    return () => {
      cancelled = true
      if (fiber) runtime.runFork(Fiber.interrupt(fiber))
    }
  }
}
