import type { Repo } from "@starbase/core"
import { GitError, WorkspaceNotConfiguredError } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect, Option } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { gitLine, runGit } from "./command.js"

/** How deep to descend from the repos directory before giving up on a branch. */
const MAX_DEPTH = 3

/** Directories never worth descending into while scanning for repos. */
const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".turbo",
  "Library",
  ".Trash"
])

/** Parse "owner/repo" from a GitHub remote URL (ssh or https), else null. */
const parseGithubSlug = (url: string | null): string | null => {
  if (url === null) return null
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
  return match?.[1] ?? null
}

type ScanEnv = FileSystem.FileSystem | Path.Path

/** Bounded-recursive scan for git repos under `rootDir`; stops at the first `.git`. */
const scan = (
  rootDir: string
): Effect.Effect<ReadonlyArray<{ name: string; path: string }>, never, ScanEnv> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: Array<{ name: string; path: string }> = []

    const walk = (dir: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > MAX_DEPTH) return
        const isRepo = yield* fs
          .exists(path.join(dir, ".git"))
          .pipe(Effect.orElseSucceed(() => false))
        if (isRepo) {
          found.push({ name: path.basename(dir), path: dir })
          return
        }
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>))
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              if (entry.startsWith(".") || IGNORE.has(entry)) return
              const child = path.join(dir, entry)
              const info = yield* fs.stat(child).pipe(Effect.option)
              if (Option.isSome(info) && info.value.type === "Directory") {
                yield* walk(child, depth + 1)
              }
            }),
          { concurrency: 8, discard: true }
        )
      })

    yield* walk(rootDir, 0)
    return found.sort((a, b) => a.name.localeCompare(b.name))
  })

/** Gather git metadata (branches, origin) for one discovered repo. */
const repoInfo = (
  entry: { name: string; path: string }
): Effect.Effect<Repo, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const currentBranch = yield* gitLine(entry.path, "rev-parse", "--abbrev-ref", "HEAD")
    const remoteUrl = yield* gitLine(entry.path, "remote", "get-url", "origin")
    const originHead = yield* gitLine(
      entry.path,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD"
    )
    const defaultBranch = originHead ? originHead.replace(/^origin\//, "") : currentBranch
    return {
      name: entry.name,
      path: entry.path,
      defaultBranch,
      currentBranch,
      remoteUrl,
      githubSlug: parseGithubSlug(remoteUrl)
    }
  })

type WorkspaceEnv =
  | ConfigService
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | AppPaths

/**
 * Discovers git repos under the configured repos directory and lists branches.
 * A malformed or absent config surfaces as `WorkspaceNotConfiguredError`, which
 * the renderer treats as "run first-run setup".
 */
export class WorkspaceService extends Effect.Service<WorkspaceService>()(
  "@starbase/WorkspaceService",
  {
    accessors: true,
    sync: () => ({
      listRepos: (): Effect.Effect<
        ReadonlyArray<Repo>,
        WorkspaceNotConfiguredError,
        WorkspaceEnv
      > =>
        Effect.gen(function* () {
          const config = yield* ConfigService.get().pipe(
            Effect.catchTag("ConfigError", () => Effect.succeed(null))
          )
          if (config === null || config.reposDir === null) {
            return yield* Effect.fail(new WorkspaceNotConfiguredError())
          }
          const entries = yield* scan(config.reposDir)
          return yield* Effect.forEach(entries, repoInfo, { concurrency: 8 })
        }),

      branches: (
        repoPath: string
      ): Effect.Effect<ReadonlyArray<string>, GitError, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["branch", "--format=%(refname:short)"]).pipe(
          Effect.map((out) =>
            out
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          )
        ),

      /** Tracked files in a repo (git ls-files), for the `@` code-reference menu. */
      files: (
        repoPath: string
      ): Effect.Effect<ReadonlyArray<string>, GitError, CommandExecutor.CommandExecutor> =>
        runGit(repoPath, ["ls-files"]).pipe(
          Effect.map((out) =>
            out
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          )
        ),

      /**
       * The unified working diff for a worktree (`git diff` incl. untracked, via
       * `--`), for the Changes rail. Empty string when the tree is clean.
       */
      diff: (
        worktreePath: string
      ): Effect.Effect<string, GitError, CommandExecutor.CommandExecutor> =>
        runGit(worktreePath, ["diff", "HEAD"])
    })
  }
) {}
