import type { CreateSessionInput, PermissionMode, Session } from "@starbase/core"
import { GitError, SessionNotFoundError } from "@starbase/core"
import { Session as SessionSchema } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
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
        input: CreateSessionInput
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
          const slug = kebab(input.title)
          const worktree = yield* GitService.createWorktree({
            repoPath: input.repoPath,
            repoName: input.repoName,
            slug,
            baseBranch: input.baseBranch
          })
          const now = yield* Effect.sync(() => new Date().toISOString())
          const stamp = yield* Effect.sync(() => Date.now().toString(36))
          const session: Session = {
            id: `s_${slug}_${stamp}`,
            repo: input.repoName,
            branch: worktree.branch,
            title: input.title,
            status: "idle",
            cli: input.cli,
            diff: { added: 0, removed: 0 },
            prNumber: null,
            costUsd: 0,
            tokens: 0,
            updatedAt: now,
            worktreePath: worktree.path,
            baseBranch: input.baseBranch
          }
          const existing = yield* readAll()
          yield* writeAll([session, ...existing])
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

      /** Add a command to the session's "always allow" list (deduped). */
      const addAllowlist = (id: string, label: string) =>
        update(id, (s) => ({
          ...s,
          allowlist: [...new Set([...(s.allowlist ?? []), label])]
        }))

      /** Link (or clear) the session's pull-request number. */
      const setPrNumber = (id: string, prNumber: number | null) =>
        update(id, (s) => ({ ...s, prNumber }))

      return { list, get, create, setMode, setModel, addAllowlist, setPrNumber }
    }
  }
) {}
