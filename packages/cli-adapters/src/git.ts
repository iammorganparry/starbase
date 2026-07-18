import type { Worktree } from "@starbase/core"
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
 * from `baseBranch`. To avoid duplicating dependencies, the worktree's
 * `node_modules` is symlinked to the origin repo's `node_modules` (best-effort;
 * a session that later changes deps simply installs locally over the link).
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
       * Anti-bloat: point the worktree's node_modules at the origin repo's, so
       * no deps are copied or reinstalled. Best-effort — never fatal.
       */
      const linkNodeModules = (
        repoPath: string,
        worktreePath: string
      ): Effect.Effect<void, never, Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          const originNodeModules = path.join(repoPath, "node_modules")
          const hasNodeModules = yield* fs
            .exists(originNodeModules)
            .pipe(Effect.orElseSucceed(() => false))
          if (hasNodeModules) {
            yield* fs
              .symlink(originNodeModules, path.join(worktreePath, "node_modules"))
              .pipe(Effect.ignore)
          }
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
            /*
             * --no-track, and it is load-bearing.
             *
             * The start point is normally `origin/<base>`, and creating a branch
             * off a remote-tracking ref triggers git's DWIM: it writes
             * `branch.starbase/<slug>.remote=origin` and `merge=refs/heads/main`.
             * The session branch then reports "up to date with origin/main", and
             * a bare `git push` inside the worktree — from the user OR from an
             * agent that has been granted push — resolves `@{u}` to `origin/main`
             * and pushes the session's commits STRAIGHT ONTO THE BASE BRANCH,
             * with no PR and no review. The whole point of a session is an
             * isolated branch; silently wiring it to push to main defeats it.
             *
             * A branch that does not exist on the remote yet has no upstream, so
             * none is the correct state. `git push -u` / `gh pr create` set it to
             * the branch's OWN remote ref on first push, which is what everything
             * downstream expects.
             */
            "--no-track",
            "-b",
            branch,
            worktreePath,
            startPoint
          ])
          yield* linkNodeModules(input.repoPath, worktreePath)
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
          yield* linkNodeModules(input.repoPath, worktreePath)
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
        worktreePath: string
      ): Effect.Effect<void, GitError, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          // The first `worktree <path>` line of the porcelain list is the main tree.
          const listRaw = yield* runString(
            "git",
            "-C",
            worktreePath,
            "worktree",
            "list",
            "--porcelain"
          )
          const mainPath = listRaw?.split("\n")[0]?.replace(/^worktree\s+/, "").trim() ?? null
          if (mainPath && mainPath !== worktreePath) {
            yield* runGit(mainPath, ["worktree", "remove", "--force", worktreePath]).pipe(
              Effect.ignore
            )
          }
        })

      return {
        worktreePathFor,
        createWorktree,
        createDetachedWorktree,
        branchAt,
        checkoutBranch,
        removeWorktreeAt
      }
    }
  }
) {}
