import type { ResolvingCommit, Worktree } from "@starbase/core"
import { GitError } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { gitLine, runGit, runString } from "./command.js"

/** Parameters for forking an isolated worktree from a repo. */
export interface CreateWorktreeInput {
  /** Absolute path to the origin repo. */
  readonly repoPath: string
  /** The repo's folder name (namespaces the worktree directory). */
  readonly repoName: string
  /** Kebab slug for the branch/worktree (branch becomes `starbase/<slug>`). */
  readonly slug: string
  /** The branch to fork from. */
  readonly baseBranch: string
}

type GitEnv =
  | AppPaths
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor

/**
 * Creates isolated git worktrees for sessions. A worktree is added under
 * `~/starbase/worktrees/<repo>/<slug>` on a fresh `starbase/<slug>` branch forked
 * from `baseBranch`.
 *
 * Dependencies are NOT mirrored here. This service used to build the worktree a
 * `node_modules` out of symlinks into the origin repo's, to avoid duplicating
 * them on disk. Two measurements retired that:
 *
 *  - It did not survive. The first `pnpm install` an agent ran inside a session
 *    replaced the mirror with a real tree — true of 33 of 39 live worktrees when
 *    this was removed, so the mirror was doing nothing in ~85% of cases.
 *  - It was not saving what it appeared to. `du` reports a worktree's
 *    `node_modules` at its full logical size, but package managers on APFS
 *    import via `clonefile`, so the blocks are already shared copy-on-write.
 *    Deleting a "1.7 GB" worktree tree returned ~310 MB of real disk.
 *
 * So a worktree now starts as a plain checkout with no `node_modules`, and the
 * agent installs when it needs to — which is what it was already doing. That is
 * also cheaper than it sounds: package managers import from a shared
 * content-addressed store, and on APFS with copy-on-write clones, so the second
 * worktree of a repo costs a fraction of the first in real blocks.
 */
export class GitService extends Effect.Service<GitService>()(
  "@starbase/GitService",
  {
    accessors: true,
    sync: () => {
      /** The `~/starbase/worktrees/<repo>/<slug>` path (pure — no side effects). */
      const worktreePathFor = (
        repoName: string,
        slug: string
      ): Effect.Effect<string, never, AppPaths | Path.Path> =>
        Effect.gen(function* () {
          const paths = yield* AppPaths
          const path = yield* Path.Path
          return path.join(paths.worktreesDir, repoName, slug)
        })

      /** Resolve the worktree path and ensure its parent directory exists. */
      const resolveWorktreePath = (
        input: CreateWorktreeInput
      ): Effect.Effect<string, GitError, AppPaths | Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          const worktreePath = yield* worktreePathFor(input.repoName, input.slug)
          yield* fs
            .makeDirectory(path.dirname(worktreePath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitError({ message: "Failed to create worktrees directory", cause })
              )
            )
          return worktreePath
        })

      /**
       * Reclaim a leftover worktree directory at `worktreePath` before adding a
       * new one there — an earlier attempt may have created the worktree but
       * failed before persisting a session, orphaning the directory. Unregister
       * it (`git worktree remove --force` + `prune`) and delete any remainder.
       * All best-effort: a clean path is a no-op. The caller is responsible for
       * not calling this on a path a live session still owns.
       */
      const reclaimStaleWorktree = (
        repoPath: string,
        worktreePath: string
      ): Effect.Effect<void, never, FileSystem.FileSystem | CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const exists = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return
          yield* runGit(repoPath, ["worktree", "remove", "--force", worktreePath]).pipe(Effect.ignore)
          yield* runGit(repoPath, ["worktree", "prune"]).pipe(Effect.ignore)
          yield* fs.remove(worktreePath, { recursive: true }).pipe(Effect.ignore)
        })


      /**
       * Best-effort refresh of `baseBranch` from origin so a new worktree forks
       * from the up-to-date remote tip rather than a stale local ref. MUST NOT
       * fail creation: offline, no `origin`, or a local-only base branch all fold
       * to a no-op (the caller then forks from the local ref). Single-branch,
       * `--no-tags` to keep the cost bounded on large repos.
       */
      const fetchBase = (
        repoPath: string,
        baseBranch: string
      ): Effect.Effect<void, never, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["fetch", "--no-tags", "origin", baseBranch]).pipe(Effect.ignore)

      /**
       * The start-point to fork the session branch from: the fresh
       * remote-tracking `origin/<baseBranch>` when it exists, else the local
       * `baseBranch`. `gitLine` folds a missing ref (rev-parse exits non-zero) to
       * null, so a local-only base or a repo without `origin` falls back cleanly.
       */
      const resolveStartPoint = (
        repoPath: string,
        baseBranch: string
      ): Effect.Effect<string, never, CommandExecutor.CommandExecutor> =>
        gitLine(repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`).pipe(
          Effect.map((sha) => (sha ? `origin/${baseBranch}` : baseBranch))
        )

      /** Fork an isolated worktree on a fresh `starbase/<slug>` branch. */
      const createWorktree = (
        input: CreateWorktreeInput
      ): Effect.Effect<Worktree, GitError, GitEnv> =>
        Effect.gen(function* () {
          const branch = `starbase/${input.slug}`
          const worktreePath = yield* resolveWorktreePath(input)
          yield* reclaimStaleWorktree(input.repoPath, worktreePath)
          // Freshen the base from origin, then fork off the remote tip when we have
          // one — so a session always starts from an up-to-date base (e.g. main).
          yield* fetchBase(input.repoPath, input.baseBranch)
          const startPoint = yield* resolveStartPoint(input.repoPath, input.baseBranch)
          yield* runGit(input.repoPath, [
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            startPoint
          ])
          // Report the logical base the user picked, not the start-point ref.
          return { path: worktreePath, branch, baseBranch: input.baseBranch, repoPath: input.repoPath }
        })

      /**
       * Add a worktree with a DETACHED HEAD at `baseBranch` (no new branch). Used
       * as the landing pad for a "session from PR" flow: the caller then runs
       * `gh pr checkout <n>` inside it, which switches this worktree onto the PR's
       * head branch. Detaching first avoids a name collision between
       * `git worktree add -b` and the PR head branch it's about to check out.
       */
      const createDetachedWorktree = (
        input: CreateWorktreeInput
      ): Effect.Effect<Worktree, GitError, GitEnv> =>
        Effect.gen(function* () {
          const worktreePath = yield* resolveWorktreePath(input)
          yield* reclaimStaleWorktree(input.repoPath, worktreePath)
          yield* runGit(input.repoPath, [
            "worktree",
            "add",
            "--detach",
            worktreePath,
            input.baseBranch
          ])
          // `branch` is a placeholder — the caller overwrites it with the real
          // head branch after `gh pr checkout` moves this worktree's HEAD.
          return {
            path: worktreePath,
            branch: input.baseBranch,
            baseBranch: input.baseBranch,
            repoPath: input.repoPath
          }
        })

      /** The current branch name checked out at `cwd`, or null (detached / error). */
      const branchAt = (
        cwd: string
      ): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
        gitLine(cwd, "rev-parse", "--abbrev-ref", "HEAD").pipe(
          Effect.map((b) => (b === null || b === "HEAD" ? null : b))
        )

      /**
       * Check out an existing local `branch` into the worktree at `cwd`, even
       * when that branch is already checked out in another worktree (the main
       * repo, typically). `--ignore-other-worktrees` bypasses git's safeguard so
       * a PR whose branch you already have checked out locally can still be
       * opened as a session — the two worktrees then share the branch ref.
       */
      const checkoutBranch = (
        cwd: string,
        branch: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        runGit(cwd, ["checkout", "--ignore-other-worktrees", branch]).pipe(Effect.asVoid)

      /**
       * Remove the worktree at `worktreePath` (deleting a session). Resolves the
       * owning repo from the worktree list — `git worktree remove` must run from
       * the main working tree, not from inside the worktree being removed — then
       * `--force`s the removal. Best-effort: a missing/dirty worktree is ignored.
       */
      const removeWorktreeAt = (
        worktreePath: string,
        /**
         * The origin repo, when the caller knows it.
         *
         * Only needed for the case this function could not previously handle at
         * all: the worktree DIRECTORY is already gone (deleted by hand, or by a
         * cleanup that did not tell git). Locating the main tree normally means
         * asking git from inside the worktree, which a missing directory makes
         * impossible — so the old code silently did nothing and left the
         * registration behind forever.
         */
        repoPath?: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          // The first `worktree <path>` line of the porcelain list is the main tree.
          // Returns null when the directory is gone — git cannot run there.
          const listRaw = yield* runString(
            "git",
            "-C",
            worktreePath,
            "worktree",
            "list",
            "--porcelain"
          )
          const discovered = listRaw?.split("\n")[0]?.replace(/^worktree\s+/, "").trim() ?? null
          const mainPath = discovered !== worktreePath ? discovered : null
          if (mainPath) {
            yield* runGit(mainPath, ["worktree", "remove", "--force", worktreePath]).pipe(
              Effect.ignore
            )
          }
          // Always prune, from whichever repo we can reach.
          //
          // `worktree remove` fails outright on a directory that no longer
          // exists, so on that path it is `prune` — which drops registrations
          // whose working tree has vanished — that does the actual work. Running
          // it after a successful remove is harmless and clears any sibling
          // entries left by earlier failures.
          const pruneFrom = mainPath ?? repoPath ?? null
          if (pruneFrom) {
            yield* runGit(pruneFrom, ["worktree", "prune"]).pipe(Effect.ignore)
          }
        })

      /**
       * The commits landed at `cwd` since `sinceSha`, OLDEST FIRST, each with the
       * files it touched. Feeds `resolveFindings`, which credits the first commit
       * touching a finding's file with fixing it — so the order is contractual,
       * hence the explicit `--reverse`.
       *
       * Folds to `[]` rather than failing on ANY git error, and the common error
       * here is not exotic: `sinceSha` is the PR head the review ran against, and
       * a force-push or a fresh clone can leave that object absent from this
       * worktree. There is nothing to do about that but decline to attribute —
       * an unresolved finding is the safe direction, a crashed review pane is not.
       *
       * Parsing: `%H<US>%s` marks a commit header (US = 0x1f, which cannot appear
       * in a subject), and `--name-only` lists that commit's paths beneath it. A
       * merge commit lists no paths under this format and simply contributes
       * nothing, which is correct — a merge fixes nothing on its own.
       */
      const commitsSince = (
        cwd: string,
        sinceSha: string
      ): Effect.Effect<ReadonlyArray<ResolvingCommit>, never, CommandExecutor.CommandExecutor> =>
        runString(
          "git",
          "-C",
          cwd,
          "log",
          `${sinceSha}..HEAD`,
          "--reverse",
          "--name-only",
          "--pretty=format:%H\x1f%s"
        ).pipe(
          Effect.map((out) => {
            if (out === null) return []
            const commits: Array<{ sha: string; subject: string; files: Array<string> }> = []
            for (const line of out.split("\n")) {
              const sep = line.indexOf("\x1f")
              if (sep !== -1) {
                commits.push({
                  sha: line.slice(0, sep),
                  subject: line.slice(sep + 1).trim(),
                  files: []
                })
                continue
              }
              const path = line.trim()
              // A path before any header cannot be attributed to a commit; drop it
              // rather than guessing (this shouldn't happen, but the parse must not
              // reach into `commits[-1]`).
              if (path.length > 0 && commits.length > 0) commits[commits.length - 1]!.files.push(path)
            }
            return commits
          })
        )

      return {
        worktreePathFor,
        createWorktree,
        createDetachedWorktree,
        branchAt,
        checkoutBranch,
        commitsSince,
        removeWorktreeAt
      }
    }
  }
) {}
