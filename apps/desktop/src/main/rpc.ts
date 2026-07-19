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
  fetchOpencodeProviders,
  filterVisible,
  GhService,
  GitService,
  McpService,
  ModelsService,
  planDraftPost,
  planReviewPost,
  retitleSession,
  ReviewService,
  ReviewStore,
  SessionStore,
  ContextManager,
  setOpencodeAuth,
  SkillsService,
  TerminalService,
  BackgroundTaskStore,
  TranscriptStore,
  UsageService,
  WorkspaceService
} from "@starbase/cli-adapters"
import { homedir } from "node:os"
import { GhError, GitError, ReviewError, resolveFindings, reviewModelFor } from "@starbase/core"
import type {
  AdversarialReview,
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  IssueSummary,
  PrMergeMethod,
  ReviewComment,
  ReviewSubmitKind,
  SettledSessionStatus
} from "@starbase/core"
import { StarbaseRpcs } from "@starbase/contracts"
import { FileSystem } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { RpcServer } from "@effect/rpc"
import type { FromClientEncoded, FromServerEncoded } from "@effect/rpc/RpcMessage"
import { Effect, Layer, Mailbox, Option, Runtime, Stream } from "effect"
import type { WebContents } from "electron"
import { ipcMain } from "electron"
import { BrowserPreviewService } from "./browser-preview.js"
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
    const cli = session?.cli ?? "claude"
    // The harness announces its own command list, so we need the binary discovery
    // resolved — a GUI-launched Electron app has a threadbare PATH, so the bare
    // name often isn't runnable (same reason `Models.list` takes it).
    const clis = yield* DiscoveryService.list().pipe(Effect.orElseSucceed(() => []))
    return yield* SkillsService.list({
      cli,
      // The operator's global skills live under the real home (~/.claude/skills),
      // never STARBASE_HOME.
      homeDir: homedir(),
      worktreePath: session?.worktreePath ?? null,
      binPath: clis.find((c) => c.kind === cli)?.binPath ?? null
    })
  })

/**
 * Where each harness's own config lives.
 *
 * `STARBASE_HARNESS_HOME` exists so the e2e suite can seed a fake `~` — the normal
 * `STARBASE_HOME` override is no use here, because MCP config lives under the
 * operator's REAL home, not Starbase's state dir. Unset in normal runs.
 */
const harnessHome = (): string => process.env.STARBASE_HARNESS_HOME ?? homedir()

/**
 * Resolve the harness + worktree an MCP request is about. A session supplies both;
 * Settings has no session, so it passes `cli` explicitly and gets user scope only
 * (there is no worktree to read project config from).
 */
const mcpSpec = (sessionId: string | null, cli: CliKind | undefined) =>
  Effect.gen(function* () {
    const session =
      sessionId === null ? null : yield* SessionStore.get(sessionId).pipe(Effect.orElseSucceed(() => null))
    return {
      /**
       * An explicitly-passed `cli` WINS over the stored session's.
       *
       * `Agent.setHarness` persists asynchronously, so right after a harness switch
       * the store still holds the old one. The renderer knows which harness it is
       * asking about and caches the answer under that key, so trusting the store
       * here would let the old harness's servers be cached under the new harness's
       * key — with `staleTime: Infinity`, permanently.
       */
      cli: cli ?? session?.cli ?? "claude",
      homeDir: harnessHome(),
      // The worktree is a property of the session, not the harness, so it is only
      // ever read from the store.
      worktreePath: session?.worktreePath ?? null
    }
  })

/** `Mcp.list` handler. Exported for tests. */
export const mcpList = (sessionId: string | null, cli: CliKind | undefined) =>
  Effect.flatMap(mcpSpec(sessionId, cli), (spec) => McpService.list(spec))

/** `Mcp.status` handler — probes the servers live. Exported for tests. */
export const mcpStatus = (sessionId: string | null, cli: CliKind | undefined, refresh: boolean | undefined) =>
  Effect.flatMap(mcpSpec(sessionId, cli), (spec) => McpService.status(spec, { refresh: refresh ?? false }))

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
 * Every model a harness offers — the WHOLE catalogue, deliberately uncurated.
 *
 * This feeds Settings' default-model picker, which is where a provider is
 * CONFIGURED. Curation (`visibleModels`) is defined as what shows in the
 * composer's model menu, so applying it here too would let it hide models from
 * the one surface you'd use to change it: curate down to three, and the fourth
 * can never be chosen as your default again — from inside the app there'd be no
 * way back. Configuration surfaces show what exists; `Models.catalog` is where
 * the operator's own choice is honoured.
 *
 * Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
 * app has a threadbare PATH, so Codex's and opencode's own model lists are only
 * reachable via the absolute path discovery found. Exported for tests.
 */
export const modelsList = (cli: CliKind) =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list()
    return yield* ModelsService.list(cli, clis.find((c) => c.kind === cli)?.binPath)
  })

/**
 * Every installed harness's models, each narrowed by its own curation — the
 * composer's model menu.
 *
 * This is the surface curation exists for: opencode's catalogue is resolved from
 * the user's own credentials, and a single OpenRouter key resolves ~342 models,
 * which is not a menu anyone can use. Applied HERE rather than inside
 * `ModelsService` so that service stays free of a config dependency (and
 * hermetically testable). Exported for tests.
 */
export const modelsCatalog = () =>
  Effect.gen(function* () {
    const clis = yield* DiscoveryService.list()
    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const catalog = yield* ModelsService.catalog(clis)
    return catalog.map((section) => ({
      ...section,
      models: filterVisible(section.models, config?.providers?.[section.cli]?.visibleModels)
    }))
  })

/** The opencode binary discovery resolved, or null when it isn't usable. */
const opencodeBin = () =>
  DiscoveryService.list().pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((clis) => clis.find((c) => c.kind === "opencode")?.binPath ?? null)
  )

/**
 * The providers opencode resolves for the user, with each credential's origin.
 * Asked of the binary rather than stored by us, because the answer belongs to
 * the user's setup — env vars, `opencode auth login`, their `opencode.json`.
 * An unreachable opencode yields an empty list (the harness reads as
 * unconfigured), never an error. Exported for tests.
 */
export const opencodeListProviders = () =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => fetchOpencodeProviders(binPath)).pipe(Effect.map((ps) => ps ?? []))
  )

/**
 * Store an API key in OPENCODE's own credential file — not `SecretStore`, which
 * stays reserved for the Starbase bearer token. The key therefore also works in
 * a bare `opencode` shell, which is the whole point of respecting their BYOK.
 * Exported for tests.
 */
export const opencodeSetAuth = (providerId: string, key: string) =>
  Effect.flatMap(opencodeBin(), (binPath) =>
    Effect.promise(() => setOpencodeAuth(binPath, providerId, key))
  )

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

/**
 * `BackgroundTasks.output` handler — a settled task's transcript.
 *
 * Best-effort by design, matching every other read path in the app: a task whose
 * `output_file` is missing, unreadable, or not yet reported yields "" rather than
 * an error. The file is written by the harness and can be cleaned up underneath
 * us, and a failed read must not take down the dock the operator is using to
 * stop something.
 */
export const backgroundTaskOutput = (sessionId: string, taskId: string) =>
  Effect.gen(function* () {
    const tasks = yield* BackgroundTaskStore.list(sessionId)
    const file = tasks.find((t) => t.id === taskId)?.outputFile
    if (!file) return ""
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
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

/** `Sessions.setStatus` handler — record a settled turn's lifecycle status. */
export const setSessionStatus = (sessionId: string, status: SettledSessionStatus) =>
  Effect.gen(function* () {
    yield* SessionStore.setStatus(sessionId, status)
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

/** `Review.get` handler — the last stored adversarial review, or null. */
export const reviewGet = (sessionId: string) => ReviewStore.get(sessionId)

/**
 * `Review.markRouted` handler — record that the stored review's critical/major
 * findings reached the agent, and return the stamp.
 *
 * Idempotent: an already-routed review keeps its original stamp rather than
 * taking a fresh one. The renderer calls this from an effect, and an effect can
 * fire twice (StrictMode, a re-render, two panes mounted on the same session) —
 * the stamp is a fact about the first routing, not about the last call.
 *
 * Returns null when there is no stored review to stamp. The renderer treats that
 * as "don't claim it's routed", which is the safe direction: the alternative is a
 * review that reads as sent while the agent never heard about it.
 */
export const reviewMarkRouted = (sessionId: string) =>
  Effect.gen(function* () {
    const review = yield* ReviewStore.get(sessionId)
    if (review === null) return null
    if (review.routedAt !== null) return review.routedAt
    const now = yield* Effect.sync(() => new Date().toISOString())
    yield* ReviewStore.set(sessionId, { ...review, routedAt: now }).pipe(Effect.ignore)
    return now
  })

/**
 * `Review.reconcile` handler — credit the commits that fixed outstanding findings.
 *
 * Returns null when nothing changed, which is the common case and the whole
 * reason the RPC is shaped this way: the renderer calls it on every settled turn,
 * and a non-null answer is its signal to publish. See the contract's doc.
 *
 * Everything here degrades to "leave it alone" rather than to an error. A review
 * that can't be reconciled (no worktree, an unreachable head SHA after a force
 * push, an unwritable reviews dir) should show its findings as still outstanding
 * — which is exactly what the stored review already says.
 *
 * Exported for tests.
 */
export const reviewReconcile = (sessionId: string) =>
  Effect.gen(function* () {
    const review = yield* ReviewStore.get(sessionId)
    if (review === null) return null
    const session = yield* resolveSession(sessionId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )
    if (!session?.worktreePath) return null

    const commits = yield* GitService.commitsSince(session.worktreePath, review.headSha)
    const now = yield* Effect.sync(() => new Date().toISOString())
    const findings = resolveFindings(review.findings, commits, now)
    // Identity, not deep equality: `resolveFindings` hands back the same array
    // when it attributed nothing, which is the fast path this leans on.
    if (findings === review.findings) return null

    const next = { ...review, findings }
    yield* ReviewStore.set(sessionId, next).pipe(Effect.ignore)
    return next
  })

/**
 * `Review.run` handler — run an adversarial review of the session's linked PR.
 *
 * The head-SHA short-circuit is the load-bearing part: it means an unchanged PR
 * costs one cheap `gh pr view` instead of an agent run. That is what lets the
 * auto-review trigger fire naively off the renderer's poll loop without needing
 * a client-side guard of its own — a duplicate effect is simply a no-op.
 *
 * Exported for tests.
 */
export const reviewRun = (sessionId: string, force: boolean) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(sessionId).pipe(
      Effect.catchAll(() => Effect.succeed(null))
    )
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(
        new ReviewError({ message: "This session has no linked pull request to review." })
      )
    }

    const headSha = yield* GhService.prHeadSha(session.worktreePath, session.prNumber)
    if (headSha === null) {
      return yield* Effect.fail(
        new ReviewError({ message: "Could not resolve the pull request's head commit." })
      )
    }

    // The de-dupe. Note it runs BEFORE the diff read and the agent spawn — the
    // whole point is that an unchanged head is nearly free.
    const prior = yield* ReviewStore.get(sessionId)
    if (!force && prior !== null && prior.headSha === headSha) return prior

    const config = yield* ConfigService.get().pipe(Effect.orElseSucceed(() => null))
    const cli = config?.github?.reviewCli ?? "claude"
    const model = reviewModelFor(cli, config?.github?.reviewModel)

    const diff = yield* GhService.prDiff(session.worktreePath, session.prNumber)

    const review = yield* ReviewService.run({
      sessionId,
      prNumber: session.prNumber,
      headSha,
      cwd: session.worktreePath,
      repo: session.repo,
      branch: session.branch,
      baseBranch: session.baseBranch ?? null,
      cli,
      model,
      diff
    })

    // Post the minor/nit half to the PR as inline comments. The critical/major
    // half is NOT posted — it goes to the session's agent, which the renderer
    // does (it owns the conversation actor; this process has no way to reach it).
    //
    // Deliberately below the de-dupe: only a FRESH run posts. The short-circuit
    // above returns `prior` untouched, so a poll tick on an unchanged head can
    // never re-post the same nits.
    const posted = yield* postReviewToPr(session.worktreePath, session.prNumber, review, diff)

    // Persist best-effort: a review the user can see now matters more than one
    // we can re-read later, and a failed write must not fail the run.
    yield* ReviewStore.set(sessionId, posted).pipe(Effect.ignore)
    return posted
  })

/**
 * Post a review's low-severity findings to the PR, returning the review stamped
 * with the outcome.
 *
 * **Best-effort by construction.** A review costs real tokens on a frontier
 * model, and its verdict is just as true whether or not GitHub accepted the
 * comments — so every failure here lands in `postError` and the findings survive.
 * Failing the run instead would throw away the whole review over a `gh` hiccup,
 * and (because the caller persists only on success) leave the auto-trigger
 * re-running the reviewer on the same head every tick.
 */
const postReviewToPr = (
  cwd: string,
  prNumber: number,
  review: AdversarialReview,
  diff: string
): Effect.Effect<AdversarialReview, never, GhService | CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const plan = planReviewPost(review, diff)
    // Nothing low-severity to say. Not an error, and not a failed post — leave
    // both stamps null so the UI reads it as "there was nothing to post".
    if (plan === null) return review

    const now = yield* Effect.sync(() => new Date().toISOString())
    return yield* GhService.prReviewComments(cwd, prNumber, {
      commitSha: review.headSha,
      body: plan.body,
      comments: plan.comments
    }).pipe(
      Effect.as({ ...review, postedAt: now, postError: null }),
      Effect.catchAll((cause) =>
        Effect.succeed({
          ...review,
          postedAt: null,
          postError: `Couldn't post the low-severity findings to the pull request: ${cause.message}`
        })
      )
    )
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

/**
 * `Github.submitReview` handler — post the reviewer's drafts as ONE COMMENT
 * review carrying line-anchored inline comments.
 *
 * Anchors against the PR's CURRENT diff and head sha rather than whatever the
 * renderer was looking at: a draft written minutes ago may sit on a line the
 * agent has since pushed over, and GitHub rejects the whole review over a single
 * stale line. `planDraftPost` folds those into the body instead.
 *
 * Returns the unanchored count so the renderer can say so.
 */
export const githubSubmitReview = (input: {
  sessionId: string
  comments: ReadonlyArray<ReviewComment>
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to review" }))
    }
    const headSha = yield* GhService.prHeadSha(session.worktreePath, session.prNumber)
    if (headSha === null) {
      return yield* Effect.fail(
        new GhError({ message: "Couldn't resolve the pull request's head commit to anchor comments against" })
      )
    }
    const diff = yield* GhService.prDiff(session.worktreePath, session.prNumber)
    const plan = planDraftPost(input.comments, diff)
    if (plan === null) return 0

    yield* GhService.prReviewComments(session.worktreePath, session.prNumber, {
      commitSha: headSha,
      body: plan.body,
      comments: plan.comments
    })
    return plan.unanchoredCount
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

/** `Github.resolveThread` handler — resolve/unresolve an inline review thread. */
export const githubResolveThread = (input: {
  sessionId: string
  threadId: string
  resolved: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath) {
      return yield* Effect.fail(new GhError({ message: "No worktree to resolve the thread from" }))
    }
    yield* GhService.resolveThread(session.worktreePath, input.threadId, input.resolved)
  })

/** `Github.replyToThread` handler — post a reply into an inline review thread. */
export const githubReplyToThread = (input: {
  sessionId: string
  commentId: number
  body: string
}) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to reply to" }))
    }
    yield* GhService.replyToThread(session.worktreePath, session.prNumber, input.commentId, input.body)
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

/** `Github.markReady` handler — flip the session's draft PR to ready for review. */
export const githubMarkReady = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to mark ready" }))
    }
    yield* GhService.prReady(session.worktreePath, session.prNumber)
  })

/** `Github.updateBranch` handler — merge the base into the PR's head on GitHub. */
export const githubUpdateBranch = (input: { sessionId: string }) =>
  Effect.gen(function* () {
    const session = yield* resolveSession(input.sessionId)
    if (!session?.worktreePath || session.prNumber === null) {
      return yield* Effect.fail(new GhError({ message: "No linked pull request to update" }))
    }
    yield* GhService.prUpdateBranch(session.worktreePath, session.prNumber)
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
  "Sessions.setStatus": ({ sessionId, status }) => setSessionStatus(sessionId, status),
  // Drop the stored review too, else ~/starbase/reviews/<id>.json outlives its
  // session forever (and a recycled id would read a stranger's findings).
  "Sessions.delete": ({ sessionId }) =>
    SessionStore.remove(sessionId).pipe(Effect.tap(() => ReviewStore.clear(sessionId))),
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
  "Agent.setHarness": ({ sessionId, cli, model }) =>
    SessionStore.setHarness(sessionId, cli, model).pipe(Effect.ignore),
  "Agent.stop": ({ sessionId }) =>
    Effect.flatMap(AgentRunner, (runner) => runner.stop(sessionId)),
  "Skills.list": ({ sessionId }) => skillsList(sessionId),
  "Mcp.list": ({ sessionId, cli }) => mcpList(sessionId, cli),
  "Mcp.status": ({ sessionId, cli, refresh }) => mcpStatus(sessionId, cli, refresh),
  // Discovery supplies the CLI's resolved binary path — a GUI-launched Electron
  // app has a threadbare PATH, so Codex's own model list is only reachable via
  // the absolute path discovery found.
  "Models.list": ({ cli }) => modelsList(cli),
  "Models.catalog": () => modelsCatalog(),
  "Opencode.listProviders": () => opencodeListProviders(),
  "Opencode.setAuth": ({ providerId, key }) => opencodeSetAuth(providerId, key),
  "Usage.get": () => Effect.flatMap(DiscoveryService.list(), (clis) => UsageService.get(clis)),
  "Context.state": ({ sessionId }) => ContextManager.snapshot(sessionId),
  // Fire-and-forget by design: the digest builds on a background fiber and lands
  // on the next turn, so the button returns instantly rather than parking the UI
  // on a summary the user is not waiting for.
  "Context.compactNow": ({ sessionId }) => ContextManager.compactNow(sessionId),
  "Config.setContext": (context) => ConfigService.setContext(context),
  // Returns the updated session so the renderer can patch its cache without a
  // refetch, matching every other session mutation.
  "Sessions.setAutoCompact": ({ id, autoCompact }) =>
    SessionStore.setAutoCompact(id, autoCompact).pipe(
      Effect.zipRight(SessionStore.get(id)),
      Effect.catchTag("SessionNotFoundError", (cause) =>
        Effect.fail(new GitError({ message: "Session not found", cause }))
      )
    ),
  "Gh.status": () => GhService.status(),
  "Config.setGithub": (github) => ConfigService.setGithub(github),
  "Config.setGit": (git) => ConfigService.setGit(git),
  "Config.setStarredRepos": ({ paths }) => ConfigService.setStarredRepos(paths),
  "Config.setCollapsedRepos": ({ paths }) => ConfigService.setCollapsedRepos(paths),
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
  "Review.run": ({ sessionId, force }) => reviewRun(sessionId, force),
  // Unwrapped from the service like `Terminal.attach` — the reviewer outlives any
  // one watcher, so the stream attaches to it rather than starting it.
  "Review.watch": ({ sessionId }) =>
    Stream.unwrap(Effect.map(ReviewService, (r) => r.watch(sessionId))),
  "Review.get": ({ sessionId }) => reviewGet(sessionId),
  "Review.markRouted": ({ sessionId }) => reviewMarkRouted(sessionId),
  "Review.reconcile": ({ sessionId }) => reviewReconcile(sessionId),
  "Github.createPr": (input) => githubCreatePr(input),
  "Github.comment": (input) => githubComment(input),
  "Github.review": (input) => githubReview(input),
  "Github.submitReview": (input) => githubSubmitReview(input),
  "Github.resolveThread": (input) => githubResolveThread(input),
  "Github.replyToThread": (input) => githubReplyToThread(input),
  "Github.merge": (input) => githubMerge(input),
  "Github.markReady": (input) => githubMarkReady(input),
  "Github.updateBranch": (input) => githubUpdateBranch(input),

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

  // Background tasks — harness work that outlives the turn that started it.
  "BackgroundTasks.list": ({ sessionId }) => BackgroundTaskStore.list(sessionId),
  "BackgroundTasks.stop": ({ sessionId, taskId }) => BackgroundTaskStore.stop(sessionId, taskId),
  "BackgroundTasks.dismiss": ({ sessionId, taskId }) => BackgroundTaskStore.dismiss(sessionId, taskId),
  "BackgroundTasks.output": ({ sessionId, taskId }) => backgroundTaskOutput(sessionId, taskId),

  // Browser preview — a native WebContentsView over a localhost dev server,
  // driven from the renderer's preview pane (bounds streamed to stay aligned).
  "BrowserPreview.open": ({ url, bounds }) =>
    Effect.flatMap(BrowserPreviewService, (b) => b.open(url, bounds)),
  "BrowserPreview.setBounds": ({ bounds }) =>
    Effect.flatMap(BrowserPreviewService, (b) => b.setBounds(bounds)),
  "BrowserPreview.navigate": ({ url }) =>
    Effect.flatMap(BrowserPreviewService, (b) => b.navigate(url)),
  "BrowserPreview.reload": () => Effect.flatMap(BrowserPreviewService, (b) => b.reload()),
  "BrowserPreview.close": () => Effect.flatMap(BrowserPreviewService, (b) => b.close()),

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
 * listener; it still requires `CommandExecutor | DiscoveryService | SessionStore
 * | ContextManager`, which `AppLayer` provides.
 *
 * `ContextManager` must be imported as a VALUE here even though this file never
 * calls it: it appears in the inferred requirement set via the handlers, and
 * TypeScript cannot NAME an inferred type that reaches into a workspace
 * package's internals without a reference to it in scope.
 */
export const RpcServerLive = RpcServer.layer(StarbaseRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(ServerProtocolLive)
)
