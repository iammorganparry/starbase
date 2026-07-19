import type {
  CliKind,
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  IssueAutomations,
  PermissionMode,
  Session,
  SettledSessionStatus
} from "@starbase/core"
import { GhError, GitError, SessionNotFoundError, UNTITLED_SESSION } from "@starbase/core"
import { Session as SessionSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { freeCreativeName } from "./creative-name.js"
import { GhService } from "./gh.js"
import { GitService } from "./git.js"

const SessionArray = Schema.Array(SessionSchema)

/** Lowercase, collapse non-alphanumeric runs to single dashes, trim; fallback "session". */
const kebab = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "session"

type PersistEnv = FileSystem.FileSystem | AppPaths

/**
 * The session store, persisted to `~/starbase/sessions.json`. Starts empty — real
 * sessions are created via `create`, which forks an isolated git worktree
 * (`GitService`) before recording the session. Reads are best-effort: a missing
 * or malformed file yields an empty list so the app still boots.
 */
export class SessionStore extends Effect.Service<SessionStore>()(
  "@starbase/SessionStore",
  {
    accessors: true,
    sync: () => {
      const readAll = (): Effect.Effect<ReadonlyArray<Session>, never, PersistEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const exists = yield* fs
            .exists(paths.sessionsFile)
            .pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const raw = yield* fs
            .readFileString(paths.sessionsFile)
            .pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return []
          return yield* Schema.decodeUnknown(Schema.parseJson(SessionArray))(raw).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<Session>)
          )
        })

      const writeAll = (
        sessions: ReadonlyArray<Session>
      ): Effect.Effect<void, GitError, PersistEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs
            .makeDirectory(paths.root, { recursive: true })
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to create ~/starbase", cause })))
          const encoded = yield* Schema.encode(SessionArray)(sessions).pipe(
            Effect.mapError((cause) => new GitError({ message: "Failed to encode sessions", cause }))
          )
          yield* fs
            .writeFileString(paths.sessionsFile, JSON.stringify(encoded, null, 2))
            .pipe(Effect.mapError((cause) => new GitError({ message: "Failed to persist session", cause })))
        })

      const list = (): Effect.Effect<ReadonlyArray<Session>, never, PersistEnv> => readAll()

      const get = (id: string): Effect.Effect<Session, SessionNotFoundError, PersistEnv> =>
        Effect.gen(function* () {
          const found = (yield* readAll()).find((s) => s.id === id)
          return found ?? (yield* Effect.fail(new SessionNotFoundError({ sessionId: id })))
        })

      const create = (
        input: CreateSessionInput,
        /** Provider defaults (from config) to stamp onto the new session. */
        options: { defaultMode?: PermissionMode; defaultModel?: string } = {}
      ): Effect.Effect<
        Session,
        GitError,
        | GitService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          // Title is optional now: blank → the agent auto-names it (provisional
          // "Untitled session"); an explicit title is pinned (autoTitle false).
          const explicit = input.title?.trim() ?? ""
          const title = explicit || UNTITLED_SESSION
          const existing = yield* readAll()
          // A titled session slugs from its title (+ a stamp so identical titles
          // never collide). An UNTITLED session gets a Docker-style friendly name
          // (e.g. "hopeful-einstein") instead of "untitled-session-<stamp>" — read
          // nicer as a branch/worktree, and picked to be unique within this repo.
          let slug: string
          if (explicit.length > 0) {
            slug = `${kebab(explicit)}-${stamp}`
          } else {
            const usedSlugs = new Set(
              existing
                .filter((s) => s.repo === input.repoName && s.worktreePath)
                .map((s) => s.worktreePath!.split("/").pop()!)
            )
            const seed = yield* Effect.sync(() => Date.now())
            slug = freeCreativeName(usedSlugs, seed, `${kebab(title)}-${stamp}`)
          }
          const worktree = yield* GitService.createWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.baseBranch
          })
          const session: Session = {
            id: `s_${slug}`,
            repo: input.repoName,
            branch: worktree.branch,
            title,
            autoTitle: explicit.length === 0,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: worktree.path,
            baseBranch: input.baseBranch,
            // Seed the session's permission mode / model from the provider's
            // configured defaults (omitted → the harness falls back on its own).
            ...(options.defaultMode ? { mode: options.defaultMode } : {}),
            ...(options.defaultModel ? { model: options.defaultModel } : {})
          }
          // `existing` was read above (for the friendly-name collision check).
          yield* writeAll([session, ...existing])
          return session
        })

      /**
       * Create a session from an *existing* PR. Lands a detached worktree on the
       * PR's base, then `gh pr checkout`s the PR — so the worktree tracks the PR's
       * head branch and the agent's commits update that PR directly. `prNumber`
       * is linked up front, so the sidebar badge + PR/Code-Review tabs light up.
       */
      const createFromPr = (
        input: CreateSessionFromPrInput,
        opts: { allowSharedCheckout: boolean } = { allowSharedCheckout: false }
      ): Effect.Effect<
        Session,
        GitError | GhError,
        | GitService
        | GhService
        | FileSystem.FileSystem
        | Path.Path
        | CommandExecutor.CommandExecutor
        | AppPaths
      > =>
        Effect.gen(function* () {
          // Key the slug on the PR number (unique per repo), not the title alone —
          // otherwise two different PRs that happen to share a title would resolve
          // to the same worktree path and the second would be refused. Including
          // the number keeps the slug stable per PR (so re-opening the same PR is
          // idempotent — see the guard below) while staying unique across PRs.
          const slug = `${kebab(input.pr.title)}-${input.pr.number}`
          // Refuse if a live session already owns this worktree path — otherwise
          // the reclaim step below would delete its worktree. (A leftover dir
          // from a failed attempt is NOT a live session, so retries still work.)
          const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
          const priorSessions = yield* readAll()
          if (priorSessions.some((s) => s.worktreePath === worktreePath)) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this pull request." })
            )
          }
          const worktree = yield* GitService.createDetachedWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.pr.baseRefName
          })
          // `gh pr checkout` fetches + switches the worktree onto the PR head
          // (and configures the fork remote for cross-repo PRs). When the head
          // branch is ALREADY checked out elsewhere (e.g. you're on it in your
          // main repo — common in dev), git refuses the switch. If the user has
          // opted in (the git "share checked-out branches" lever), fall back to a
          // shared checkout so the PR can still be opened as a session.
          const checkout = GhService.checkoutPr(worktree.path, input.pr.number)
          yield* opts.allowSharedCheckout
            ? checkout.pipe(
                Effect.catchIf(
                  (e) => /already checked out|already used by worktree/i.test(e.message),
                  () => GitService.checkoutBranch(worktree.path, input.pr.headRefName)
                )
              )
            : checkout
          // The live branch after checkout is the PR head; fall back to the
          // reported head ref if `rev-parse` can't resolve it.
          const branch = (yield* GitService.branchAt(worktree.path)) ?? input.pr.headRefName
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const session: Session = {
            id: `s_${slug}_${stamp}`,
            repo: input.repoName,
            branch,
            title: input.pr.title,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: input.pr.number,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: worktree.path,
            baseBranch: input.pr.baseRefName
          }
          const existing = yield* readAll()
          yield* writeAll([session, ...existing])
          return session
        })

      /**
       * Create a session from a GitHub issue. Like `create` it forks a FRESH
       * `starbase/<number>-<slug>` branch off `baseBranch` (the issue number keys
       * the slug so it's unique per repo and reads well), but it links the issue,
       * enables the chosen automations, and seeds `initialPrompt` from the issue
       * title + body (the composer pre-fills it once; HITL — the user sends it).
       */
      const createFromIssue = (
        input: CreateSessionFromIssueInput,
        options: { defaultMode?: PermissionMode; defaultModel?: string } = {}
      ): Effect.Effect<
        Session,
        GitError,
        GitService | FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths
      > =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const slug = `${input.issue.number}-${kebab(input.issue.title)}`
          // Guard: one session per issue worktree (the slug is deterministic).
          const worktreePath = yield* GitService.worktreePathFor(input.repoName, slug)
          const prior = yield* readAll()
          if (prior.some((s) => s.worktreePath === worktreePath)) {
            return yield* Effect.fail(
              new GitError({ message: "A session already exists for this issue." })
            )
          }
          const worktree = yield* GitService.createWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.baseBranch
          })
          // Prefer the edited task from the dialog; fall back to title + body.
          const task =
            input.task.trim() ||
            [input.issue.title, input.issue.body]
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
              .join("\n\n")
          const session: Session = {
            // Stamp the id (like `createFromPr`) so a delete-then-recreate of the
            // same issue can't collide with the old session's persisted data; the
            // worktree slug stays deterministic for the one-session-per-issue guard.
            id: `s_${slug}_${stamp}`,
            repo: input.repoName,
            branch: worktree.branch,
            // Seed (and pin) the title from the issue.
            title: input.issue.title,
            autoTitle: false,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            issueNumber: input.issue.number,
            issueUrl: input.issue.url,
            issueTitle: input.issue.title,
            issueLabels: input.issue.labels.map((l) => ({ name: l.name, color: l.color })),
            automations: input.automations,
            ...(task.length > 0 ? { initialPrompt: task } : {}),
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: worktree.path,
            baseBranch: input.baseBranch,
            ...(options.defaultMode ? { mode: options.defaultMode } : {}),
            ...(options.defaultModel ? { model: options.defaultModel } : {})
          }
          yield* writeAll([session, ...prior])
          return session
        })

      /** Apply `patch` to the matching session and persist; no-op if absent. */
      const update = (
        id: string,
        patch: (session: Session) => Session
      ): Effect.Effect<void, GitError, PersistEnv> =>
        Effect.gen(function* () {
          const all = yield* readAll()
          if (!all.some((s) => s.id === id)) return
          yield* writeAll(all.map((s) => (s.id === id ? patch(s) : s)))
        })

      /** Persist the session's HITL permission mode. */
      const setMode = (id: string, mode: PermissionMode) => update(id, (s) => ({ ...s, mode }))

      /** Persist the session's harness model. */
      const setModel = (id: string, model: string) => update(id, (s) => ({ ...s, model }))

      /**
       * Accrue what a finished turn reported, ADDING to the session's running
       * total rather than replacing it — a session is many turns, and the last
       * one's usage is not the session's usage.
       *
       * `costUsd` is the harness's own figure. On subscription auth it is a
       * NOTIONAL api-equivalent price rather than money billed, which is worth
       * knowing before treating it as spend: the billing pane is what says which
       * of the two an operator is actually on. Recorded regardless, because "how
       * expensive was this work" is a useful question either way; it is the
       * interpretation that differs, not the number.
       */
      const addUsage = (id: string, usage: { costUsd: number; tokens: number }) =>
        update(id, (s) => ({
          ...s,
          costUsd: s.costUsd + (Number.isFinite(usage.costUsd) ? usage.costUsd : 0),
          tokens: s.tokens + (Number.isFinite(usage.tokens) ? usage.tokens : 0)
        }))

      /**
       * Switch the session's harness and model together.
       *
       * When `cli` actually changes, `resumeId` MUST be dropped: it holds the
       * *previous* harness's thread id, and handing a Codex thread id to Claude
       * (or vice versa) would either error or resume something unrelated. The new
       * harness therefore starts a fresh thread — the transcript on screen is
       * unaffected, but the agent won't recall earlier turns.
       *
       * `plan` mode is Claude-only, so leaving Claude coerces it back to `ask`
       * rather than handing a mode the new harness can't honour to the runner.
       */
      const setHarness = (id: string, cli: CliKind, model: string) =>
        update(id, (s) =>
          s.cli === cli
            ? { ...s, model }
            : {
                ...s,
                cli,
                model,
                // `optional`, not nullable — undefined drops the key on write.
                resumeId: undefined,
                mode: s.mode === "plan" && cli !== "claude" ? "ask" : s.mode
              }
        )

      /** Persist the harness session id so the conversation resumes after a restart. */
      const setResumeId = (id: string, resumeId: string) => update(id, (s) => ({ ...s, resumeId }))

      /** Persist an auto-generated title (leaves `autoTitle` untouched). */
      const setTitle = (id: string, title: string) => update(id, (s) => ({ ...s, title }))

      /** Manual rename — pins the title so the agent stops auto-retitling it. */
      const renameTitle = (id: string, title: string) =>
        update(id, (s) => ({ ...s, title, autoTitle: false }))

      /**
       * Record the session's lifecycle status as a turn settles. An archived
       * session is terminal — never drag it back to idle/needs-input, or the
       * sidebar would show a merged session as if it still wanted attention.
       */
      const setStatus = (id: string, status: SettledSessionStatus) =>
        update(id, (s) => (s.archived ? s : { ...s, status }))

      /** Add a command to the session's "always allow" list (deduped). */
      const addAllowlist = (id: string, label: string) =>
        update(id, (s) => ({
          ...s,
          allowlist: [...new Set([...(s.allowlist ?? []), label])]
        }))

      /** Link (or clear) the session's pull-request number. */
      const setPrNumber = (id: string, prNumber: number | null) =>
        update(id, (s) => ({ ...s, prNumber }))

      /** Link (or, with `null`, unlink) a GitHub issue on a live session. */
      const setIssue = (
        id: string,
        issue: {
          number: number
          url: string
          title: string
          labels: ReadonlyArray<{ name: string; color: string | null }>
          automations: IssueAutomations
        } | null
      ) =>
        update(id, (s) =>
          issue
            ? {
                ...s,
                issueNumber: issue.number,
                issueUrl: issue.url,
                issueTitle: issue.title,
                issueLabels: issue.labels,
                automations: issue.automations
              }
            : {
                ...s,
                issueNumber: undefined,
                issueUrl: undefined,
                issueTitle: undefined,
                issueLabels: undefined,
                automations: undefined
              }
        )

      /** Clear the one-shot `initialPrompt` once the composer has consumed it. */
      const clearInitialPrompt = (id: string) =>
        update(id, (s) => ({ ...s, initialPrompt: undefined }))

      /** Archive a session (its linked PR was merged/closed) — read-only, kept. */
      const archive = (id: string, reason: "merged" | "closed") =>
        Effect.gen(function* () {
          const now = yield* Effect.sync(() => new Date().toISOString())
          yield* update(id, (s) => ({
            ...s,
            archived: true,
            archiveReason: reason,
            archivedAt: now
          }))
        })

      /** Restore an archived session back to an editable state. */
      const restore = (id: string) =>
        update(id, (s) => ({
          ...s,
          archived: false,
          archiveReason: undefined,
          archivedAt: undefined
        }))

      /**
       * Permanently delete a session: remove its worktree (best-effort) and drop
       * it from the store. Irreversible — the UI gates this behind a confirm.
       */
      const remove = (
        id: string
      ): Effect.Effect<
        void,
        GitError,
        GitService | FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths
      > =>
        Effect.gen(function* () {
          const all = yield* readAll()
          const target = all.find((s) => s.id === id)
          if (!target) return
          if (target.worktreePath) {
            yield* GitService.removeWorktreeAt(target.worktreePath).pipe(Effect.ignore)
          }
          yield* writeAll(all.filter((s) => s.id !== id))
        })

      return {
        list,
        get,
        create,
        createFromPr,
        createFromIssue,
        setMode,
        setModel,
        addUsage,
        setHarness,
        setResumeId,
        setTitle,
        renameTitle,
        setStatus,
        addAllowlist,
        setPrNumber,
        setIssue,
        clearInitialPrompt,
        archive,
        restore,
        remove
      }
    }
  }
) {}
