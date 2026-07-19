import type { Worktree } from "@starbase/core"
import { GitError } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { gitLine, runGit, runString } from "./command.js"
import type { RepoKey } from "@starbase/core"
import { repoKeyFrom } from "@starbase/core"
import { createHash } from "node:crypto"

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
/** The digest `repo-key.ts` builds keys with; supplied here because core is also bundled into the renderer. */
const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex")

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
      /**
       * The repository's stable identity — see `repo-key.ts` for why this is the
       * root commit rather than a path, a name, or a remote.
       *
       * Reads the remote too, as the fallback for a shallow clone: `rev-list
       * --max-parents=0` on a shallow clone returns the SHALLOW BOUNDARY rather
       * than a true root, and that boundary differs by clone depth — so two
       * teammates would derive different "strong" keys for one repo and their
       * evidence would silently shard. `--is-shallow-repository` is what tells
       * the two cases apart; without it the fallback would never fire.
       */
      const repoKey = (
        repoPath: string
      ): Effect.Effect<RepoKey | null, never, CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const shallow = yield* gitLine(repoPath, "rev-parse", "--is-shallow-repository")
          const roots =
            shallow === "true"
              ? []
              : ((yield* runString("git", "-C", repoPath, "rev-list", "--max-parents=0", "HEAD")) ??
                  "")
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0)
          const remote = yield* gitLine(repoPath, "config", "--get", "remote.origin.url")
          return repoKeyFrom({ roots, remote }, sha256Hex)
        })

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
        repoKey,
        checkoutBranch,
        removeWorktreeAt
      }
    }
  }
) {}
