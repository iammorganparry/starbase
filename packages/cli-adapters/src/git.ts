import type { Worktree } from "@starbase/core"
import { GitError } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { runGit } from "./command.js"

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
    sync: () => ({
      createWorktree: (
        input: CreateWorktreeInput
      ): Effect.Effect<Worktree, GitError, GitEnv> =>
        Effect.gen(function* () {
          const paths = yield* AppPaths
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem

          const branch = `starbase/${input.slug}`
          const repoWorktreesDir = path.join(paths.worktreesDir, input.repoName)
          const worktreePath = path.join(repoWorktreesDir, input.slug)

          yield* fs
            .makeDirectory(repoWorktreesDir, { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitError({ message: "Failed to create worktrees directory", cause })
              )
            )

          yield* runGit(input.repoPath, [
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            input.baseBranch
          ])

          // Anti-bloat: point the worktree's node_modules at the origin repo's,
          // so no deps are copied or reinstalled. Best-effort — never fatal.
          const originNodeModules = path.join(input.repoPath, "node_modules")
          const hasNodeModules = yield* fs
            .exists(originNodeModules)
            .pipe(Effect.orElseSucceed(() => false))
          if (hasNodeModules) {
            yield* fs
              .symlink(originNodeModules, path.join(worktreePath, "node_modules"))
              .pipe(Effect.ignore)
          }

          return {
            path: worktreePath,
            branch,
            baseBranch: input.baseBranch,
            repoPath: input.repoPath
          }
        })
    })
  }
) {}
