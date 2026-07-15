/**
 * RPC transport — the crux of the app.
 *
 * APPROACH: the real `@effect/rpc` machinery, wired over Electron IPC with a
 * pair of *custom Protocols* (NOT the hand-rolled dispatch fallback). The main
 * process runs `RpcServer` and the renderer runs `RpcClient`; both are driven
 * by the shared `StarbaseRpcs` group, which stays the single source of truth for
 * every payload/success/error schema. The only thing crossing the IPC boundary
 * is already-encoded, JSON-safe `FromClientEncoded` / `FromServerEncoded` frames
 * on one channel (`RPC_CHANNEL`); RpcServer/RpcClient own all schema
 * encode/decode. (We avoid the no-serialization path because its *decoded*
 * frames carry Effect `Exit`/`Cause` class instances that don't survive
 * Electron's structured-clone IPC.)
 */
import {
  AgentRunner,
  AuthService,
  ConfigService,
  claudeTitleGenerator,
  DiscoveryService,
  GhService,
  ModelsService,
  retitleSession,
  SessionStore,
  SkillsService,
  TerminalService,
  TranscriptStore,
  UsageService,
  WorkspaceService
} from "@starbase/cli-adapters"
import { homedir } from "node:os"
import { GhError, GitError } from "@starbase/core"
import type {
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  IssueSummary,
  PrMergeMethod,
  ReviewSubmitKind
} from "@starbase/core"
import { StarbaseRpcs } from "@starbase/contracts"
import { RpcServer } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Layer, Mailbox, Option, Runtime, Stream } from "effect"
import type { WebContents } from "electron"
import { ipcMain } from "electron"
import { DialogService } from "./dialog.js"

/** The single IPC channel both directions of the RPC transport ride on. */
export const RPC_CHANNEL = "starbase/rpc"

/**
 * `Config.get` handler. A malformed or absent config folds to `null` so the
 * renderer treats it as "not configured yet" and shows first-run setup, rather
 * than surfacing a read error. Exported so its folding behaviour is unit-tested.
 */
export const configGet = () => ConfigService.get().pipe(Effect.orElseSucceed(() => null))

/**
 * `Setup.chooseReposDir` handler. Opens the native picker; a cancelled dialog (or
 * any failure) folds to `null`, otherwise the chosen dir is persisted and the new
 * config returned. Exported so the cancel/persist branches are unit-tested.
 */
export const chooseReposDir = () =>
  Effect.gen(function* () {
    const dialog = yield* DialogService
    const dir = yield* dialog.chooseDirectory()
    if (dir === null) return null
    return yield* ConfigService.setReposDir(dir)
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * `Skills.list` handler. Resolves the session's harness + worktree (best-effort;
 * an unknown session falls back to Claude with no worktree) so `SkillsService`
 * can report the harness-appropriate skills for the `/` menu. Exported for tests.
 */
export const skillsList = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
    return yield* SkillsService.list({
      cli: session?.cli ?? "claude",
      // The operator's global skills live under the real home (~/.claude/skills),
      // never STARBASE_HOME.
      homeDir: homedir(),
      worktreePath: session?.worktreePath ?? null
    })
  })

/**
 * `Sessions.diff` handler. Resolves the session's worktree and returns its
 * unified working diff (empty when there's no worktree or the tree is clean, or
 * on any git failure — the Changes rail treats that as "no changes yet").
 * Exported for tests.
 */
export const sessionDiff = (id: string) =>
  Effect.gen(function* () {
    const session = yield* SessionStore.get(id).pipe(Effect.orElseSucceed(() => null))
    if (!session?.worktreePath) return ""
    return yield* WorkspaceService.diff(session.worktreePath).pipe(Effect.orElseSucceed(() => ""))
  })

/** Resolve a session (best-effort; unknown → null) for the GitHub handlers. */
const resolveSession = (sessionId: string) =>
  SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))

/**
 * `Sessions.createFromPr` handler. Reads the git "share checked-out branches"
 * lever from config (default on) and passes it through, so a PR whose branch is
 * already checked out locally can be opened as a session when the user allows it.
 */
export const createSessionFromPr = (input: CreateSessionFromPrInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const allowSharedCheckout = config?.git?.shareCheckedOutBranches ?? true
    return yield* SessionStore.createFromPr(input, { allowSharedCheckout })
  })

/**
 * `Sessions.create` handler. Seeds the new session's permission mode + model
 * from the chosen CLI's configured provider defaults (Settings · Providers), so
 * a session opens in the mode/model the user picked. Absent config → the store
 * omits them and the harness applies its own defaults. Exported for tests.
 */
export const createSession = (input: CreateSessionInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const provider = config?.providers?.[input.cli]
    return yield* SessionStore.create(input, {
      defaultMode: provider?.defaultMode,
      defaultModel: provider?.defaultModel
    })
  })

/**
 * `Sessions.createFromIssue` handler. Like `createSession` (fresh branch, same
 * provider-default seeding) but links the issue + automations and seeds the task
 * from the issue. Exported for tests.
 */
export const createSessionFromIssue = (input: CreateSessionFromIssueInput) =>
  Effect.gen(function* () {
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const provider = config?.providers?.[input.cli]
    return yield* SessionStore.createFromIssue(input, {
      defaultMode: provider?.defaultMode,
      defaultModel: provider?.defaultModel
    })
  })

/** `Sessions.linkIssue` handler — attach an issue (+ automations) to a live session. */
export const linkIssue = (input: {
  sessionId: string
  issue: IssueSummary
  automations: IssueAutomations
}) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(input.sessionId, {
      number: input.issue.number,
      url: input.issue.url,
      title: input.issue.title,
      labels: input.issue.labels.map((l) => ({ name: l.name, color: l.color })),
      automations: input.automations
    })
    return yield* SessionStore.get(input.sessionId)
  })

/** `Sessions.unlinkIssue` handler — detach the session's issue. */
export const unlinkIssue = (sessionId: string) =>
  Effect.gen(function* () {
    yield* SessionStore.setIssue(sessionId, null)
    return yield* SessionStore.get(sessionId)
  })

/**
 * `Github.closeIssue` handler — close the session's linked issue (close-on-merge).
 * Fails with `GhError` when there's no worktree or linked issue.
 */
export const githubCloseIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.issueNumber == null) {
      return yield* Effect.fail(new GhError({ message: "No linked issue to close" }))
    }
    yield* GhService.closeIssue(session.worktreePath, session.issueNumber)
  })

/** `Github.issue` handler — the full linked-issue view model for the Issue tab. */
export const githubIssue = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.issueNumber == null) return null
    return yield* GhService.issueView(session.worktreePath, session.issueNumber)
  })

/**
 * `Workspace.revertFile` handler — discard all uncommitted changes to `path` in
 * the session's worktree. A no-op for an unknown / worktree-less session.
 */
export const workspaceRevertFile = (input: { sessionId: string; path: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) return
    yield* WorkspaceService.revertFile(session.worktreePath, input.path)
  })

/**
 * `Workspace.revertLines` handler — revert just the uncommitted changes in a
 * line range of `path` in the session's worktree. No-op for an unknown session.
 */
export const workspaceRevertLines = (input: {
  sessionId: string
  path: string
  startLine: number
  endLine: number
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) return
    yield* WorkspaceService.revertRange(session.worktreePath, input.path, input.startLine, input.endLine)
  })

/**
 * `Github.pr` handler. Returns the linked PR (via `gh pr view`) or null when the
 * session has no worktree or no linked PR. Exported for tests.
 */
export const githubPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return null
    return yield* GhService.prView(session.worktreePath, session.prNumber)
  })

/**
 * `Github.prState` handler — the lifecycle state of a session's linked PR (or
 * null when there's no worktree / linked PR). Drives the archive sweep. Exported
 * for tests.
 */
export const githubPrState = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return null
    return yield* GhService.prState(session.worktreePath, session.prNumber)
  })

/** `Sessions.archive` handler — archive a session and return the updated record. */
export const archiveSession = (sessionId: string, reason: "merged" | "closed") =>
  Effect.gen(function* () {
    yield* SessionStore.archive(sessionId, reason)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Sessions.restore` handler — un-archive a session and return the updated record. */
export const restoreSession = (sessionId: string) =>
  Effect.gen(function* () {
    yield* SessionStore.restore(sessionId)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Sessions.rename` handler — pin a manual title and return the updated record. */
export const renameSession = (sessionId: string, title: string) =>
  Effect.gen(function* () {
    yield* SessionStore.renameTitle(sessionId, title)
    return yield* SessionStore.get(sessionId)
  }).pipe(
    Effect.catchTag("SessionNotFoundError", () =>
      Effect.fail(new GitError({ message: "Session not found" }))
    )
  )

/** `Github.files` handler — the PR's changed files (empty without a linked PR). */
export const githubFiles = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return []
    return yield* GhService.prFiles(session.worktreePath, session.prNumber)
  })

/** `Github.diff` handler — the PR's unified diff (empty without a linked PR). */
export const githubDiff = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath || session.prNumber === null) return ""
    return yield* GhService.prDiff(session.worktreePath, session.prNumber)
  })

/**
 * `Github.detectPr` handler. Looks up a PR open on the session's branch and, when
 * found, links it (persists `prNumber`). Returns the number, or null. Exported for tests.
 */
export const githubDetectPr = (sessionId: string) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId)
    if (!session?.worktreePath) return null
    // Resolve against the worktree's live branch — the stored `session.branch`
    // drifts once the agent checks out / creates a different branch there.
    const n = yield* GhService.prForWorktree(session.worktreePath)
    if (n !== null) yield* SessionStore.setPrNumber(session.id, n).pipe(Effect.ignore)
    return n
  })

/** `Github.createPr` handler — open a PR from the session's branch and link it. */
export const githubCreatePr = (input: {
  sessionId: string
  title: string
  body: string
  base: string
  draft: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) {
      return yield* Effect.fail(new GhError({ message: "Session has no worktree to open a PR from" }))
    }
    const n = yield* GhService.prCreate(session.worktreePath, {
      title: input.title,
      body: input.body,
      base: input.base,
      draft: input.draft
    })
    yield* SessionStore.setPrNumber(session.id, n).pipe(Effect.ignore)
    return n
  })

/**
 * `Github.comment` handler — post a top-level PR comment when `toGithub`. The
 * renderer separately feeds the body to the agent (`Agent.run`), so this only
 * owns the GitHub write.
 */
export const githubComment = (input: { sessionId: string; body: string; toGithub: boolean }) =>
  Effect.gen(function* () {
    if (!input.toGithub) return
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to comment on" }))
    }
    yield* GhService.prComment(session.worktreePath, session.prNumber, input.body)
  })

/** `Github.review` handler — submit a review (comment/approve/request-changes). */
export const githubReview = (input: {
  sessionId: string
  kind: ReviewSubmitKind
  body: string
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to review" }))
    }
    yield* GhService.prReview(session.worktreePath, session.prNumber, input.kind, input.body)
  })

/** `Github.merge` handler — merge the session's linked PR (merge commit by default). */
export const githubMerge = (input: { sessionId: string; method?: PrMergeMethod }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to merge" }))
    }
    yield* GhService.prMerge(session.worktreePath, session.prNumber, input.method)
  })

/**
 * `Terminal.create` handler. Resolves the terminal's working directory: an
 * explicit `cwd` wins, else the session's worktree, else the main-process cwd
 * (the service's own fallback). Keeping the resolution here means the renderer
 * can stay oblivious to worktree paths. Exported for tests.
 */
export const createTerminal = (input: {
  sessionId: string
  cwd?: string
  cols: number
  rows: number
}) =>
  Effect.gen(function* () {
    const cwd = input.cwd ?? (yield* resolveSession(input.sessionId))?.worktreePath ?? undefined
    const terminals = yield* TerminalService
    return yield* terminals.create({ sessionId: input.sessionId, cwd, cols: input.cols, rows: input.rows })
  })

/**
 * Handlers for every procedure in the group. Each one delegates straight to an
 * Effect service, so the group remains the sole contract. `Discovery.list`
 * pulls in a `CommandExecutor` requirement (via `DiscoveryService.list()`) that
 * `AppLayer` satisfies with the Node platform layer.
 */
const HandlersLayer = StarbaseRpcs.toLayer({
  "Discovery.list": () => DiscoveryService.list(),
  "Config.get": configGet,
  "Setup.chooseReposDir": chooseReposDir,
  "Workspace.repos": () => WorkspaceService.listRepos(),
  "Workspace.branches": ({ repoPath }) => WorkspaceService.branches(repoPath),
  "Workspace.files": ({ repoPath }) => WorkspaceService.files(repoPath),
  "Workspace.revertFile": (input) => workspaceRevertFile(input),
  "Workspace.revertLines": (input) => workspaceRevertLines(input),
  "Sessions.list": () => SessionStore.list(),
  "Sessions.get": ({ id }) => SessionStore.get(id),
  "Sessions.create": (input) => createSession(input),
  "Sessions.createFromPr": (input) => createSessionFromPr(input),
  "Sessions.createFromIssue": (input) => createSessionFromIssue(input),
  "Sessions.linkIssue": (input) => linkIssue(input),
  "Sessions.unlinkIssue": ({ sessionId }) => unlinkIssue(sessionId),
  "Sessions.clearInitialPrompt": ({ sessionId }) =>
    Effect.gen(function* () {
      yield* SessionStore.clearInitialPrompt(sessionId)
      return yield* SessionStore.get(sessionId)
    }),
  "Sessions.archive": ({ sessionId, reason }) => archiveSession(sessionId, reason),
  "Sessions.restore": ({ sessionId }) => restoreSession(sessionId),
  "Sessions.retitle": ({ sessionId }) => retitleSession(sessionId, claudeTitleGenerator),
  "Sessions.rename": ({ sessionId, title }) => renameSession(sessionId, title),
  "Sessions.delete": ({ sessionId }) => SessionStore.remove(sessionId),
  "Sessions.transcript": ({ id }) => TranscriptStore.list(id),
  "Sessions.diff": ({ id }) => sessionDiff(id),
  // The streaming agent seam: unwrap the runner's `Stream<StreamEvent>` so the
  // renderer subscribes to normalized events, harness-agnostic.
  "Agent.run": ({ sessionId, text, images }) =>
    Stream.unwrap(Effect.map(AgentRunner, (runner) => runner.prompt(sessionId, text, images ?? []))),
  "Agent.decideGate": ({ sessionId, gateId, decision }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.decideGate(sessionId, gateId, decision)),
  "Agent.answerQuestion": ({ sessionId, requestId, answers }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.answerQuestion(sessionId, requestId, answers)),
  "Agent.setMode": ({ sessionId, mode }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.setMode(sessionId, mode)),
  "Agent.commentPlanStep": ({ sessionId, planId, stepId, body }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.commentPlanStep(sessionId, planId, stepId, body)),
  "Agent.revisePlan": ({ sessionId, planId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.revisePlan(sessionId, planId)),
  "Agent.approvePlan": ({ sessionId, planId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.approvePlan(sessionId, planId)),
  "Agent.resumePlan": ({ sessionId, planId }) =>
    Stream.unwrap(Effect.map(AgentRunner, (runner) => runner.resumePlan(sessionId, planId))),
  "Agent.setModel": ({ sessionId, model }) =>
    SessionStore.setModel(sessionId, model).pipe(Effect.ignore),
  "Agent.stop": ({ sessionId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.stop(sessionId)),
  "Skills.list": ({ sessionId }) => skillsList(sessionId),
  "Models.list": ({ cli }) => ModelsService.list(cli),
  "Usage.get": () => Effect.flatMap(DiscoveryService.list(), (clis) => UsageService.get(clis)),
  "Gh.status": () => GhService.status(),
  "Config.setGithub": (github) => ConfigService.setGithub(github),
  "Config.setGit": (git) => ConfigService.setGit(git),
  "Config.setStarredRepos": ({ paths }) => ConfigService.setStarredRepos(paths),
  "Config.setLastRepoPath": ({ path }) => ConfigService.setLastRepoPath(path),
  "Config.setProvider": ({ cli, provider }) => ConfigService.setProvider(cli, provider),
  "Github.pr": ({ sessionId }) => githubPr(sessionId),
  "Github.prState": ({ sessionId }) => githubPrState(sessionId),
  "Github.listPrs": ({ repoPath, mine, search }) => GhService.listPrs(repoPath, { mine, search }),
  "Github.listIssues": ({ repoPath, mine, search }) =>
    GhService.listIssues(repoPath, { mine, search }),
  "Github.closeIssue": ({ sessionId }) => githubCloseIssue(sessionId),
  "Github.issue": ({ sessionId }) => githubIssue(sessionId),
  "Github.files": ({ sessionId }) => githubFiles(sessionId),
  "Github.diff": ({ sessionId }) => githubDiff(sessionId),
  "Github.detectPr": ({ sessionId }) => githubDetectPr(sessionId),
  "Github.createPr": (input) => githubCreatePr(input),
  "Github.comment": (input) => githubComment(input),
  "Github.review": (input) => githubReview(input),
  "Github.merge": (input) => githubMerge(input),

  // Terminal — PTY lifecycle is unary; the coalesced output path is a stream,
  // unwrapped from the service like `Agent.run`.
  "Terminal.create": (input) => createTerminal(input),
  "Terminal.attach": ({ terminalId }) =>
    Stream.unwrap(Effect.map(TerminalService, (t) => t.attach(terminalId))),
  "Terminal.write": ({ terminalId, data }) =>
    Effect.flatMap(TerminalService, (t) => t.write(terminalId, data)),
  "Terminal.resize": ({ terminalId, cols, rows }) =>
    Effect.flatMap(TerminalService, (t) => t.resize(terminalId, cols, rows)),
  "Terminal.kill": ({ terminalId }) =>
    Effect.flatMap(TerminalService, (t) => t.kill(terminalId)),
  "Terminal.list": ({ sessionId }) =>
    Effect.flatMap(TerminalService, (t) => t.list(sessionId)),

  // Auth — the sign-in wall. Delegates to AuthService, which bridges the OS
  // keychain (SecretStore) and the BetterAuth backend.
  "Auth.getSession": () => AuthService.getSession(),
  "Auth.startSignIn": ({ provider }) => AuthService.startSignIn(provider),
  "Auth.sendMagicLink": ({ email, name }) => AuthService.sendMagicLink(email, name),
  "Auth.signOut": () => AuthService.signOut()
})

/**
 * There is exactly one renderer. We remember its `WebContents` from the most
 * recent inbound frame so the server can push responses back to it. Requests
 * always arrive after the window has loaded, so this is set before any `send`.
 */
let sender: WebContents | null = null

/**
 * A custom `RpcServer.Protocol` that pumps encoded frames over `ipcMain` /
 * `webContents.send`. `writeRequest` feeds an inbound client frame into the
 * server core; `send` ships a server response back to the renderer.
 */
const ServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make((writeRequest) =>
    Effect.gen(function* () {
      const disconnects = yield* Mailbox.make<number>()
      const runFork = Runtime.runFork(yield* Effect.runtime<never>())

      ipcMain.on(RPC_CHANNEL, (event, data: FromClientEncoded) => {
        sender = event.sender
        runFork(writeRequest(event.sender.id, data))
      })

      return {
        disconnects,
        send: (_clientId: number, response: FromServerEncoded) =>
          Effect.sync(() => sender?.send(RPC_CHANNEL, response)),
        end: (_clientId: number) => Effect.void,
        clientIds: Effect.sync(() => new Set(sender ? [sender.id] : [])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false
      }
    })
  )
)

/**
 * The running RPC server: the group's handlers served over the IPC protocol.
 * Building this layer forks the server daemon and registers the `ipcMain`
 * listener; it still requires `CommandExecutor | DiscoveryService | SessionStore`,
 * which `AppLayer` provides.
 */
export const RpcServerLive = RpcServer.layer(StarbaseRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(ServerProtocolLive)
)
