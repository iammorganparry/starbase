import type { ResolvingCommit, Worktree } from "@starbase/core"
import { GitError } from "@starbase/core"
import { FileSystem, Path } from "@effect/platform"
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { gitLine, runGit, runString } from "./command.js"

/**
 * Is `candidate` the directory `root`, or somewhere beneath it?
 *
 * Compares path SEGMENTS, not string prefixes: `/repo-backup` starts with
 * `/repo` as text but is a different tree, and treating it as contained would
 * misclassify its packages as workspace members. Both arguments are expected to
 * be already-resolved absolute paths.
 */
const isWithin = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`)

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
 * To avoid duplicating dependencies, the worktree's `node_modules` MIRRORS the
 * origin repo's: third-party packages are symlinked (nothing copied), while
 * workspace packages are re-pointed at the worktree's own source — see
 * `mirrorEntry`. Best-effort; a session that later changes deps simply installs
 * locally over the links.
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
       * Directories inside `node_modules` that hold OTHER entries rather than
       * being a package themselves, so they must be rebuilt entry-by-entry
       * instead of linked whole. `@scope` dirs mix third-party packages with
       * workspace links; `.bin` mixes third-party shims with workspace ones.
       */
      const isContainerDir = (name: string): boolean => name.startsWith("@") || name === ".bin"

      /**
       * Mirror one `node_modules` entry into the worktree.
       *
       * THE BUG THIS EXISTS FOR: symlinking `node_modules` wholesale was correct
       * for a single-package repo and silently wrong for a workspace monorepo.
       * A workspace link inside it (`node_modules/@acme/web -> ../../apps/web`)
       * is RELATIVE, so following it from the worktree resolved back into the
       * ORIGIN checkout — every workspace import in a session read main's
       * source instead of the branch's. Agents then edited one tree and
       * type-checked another, producing errors that pointed at code the branch
       * had already changed.
       *
       * So each entry is classified by where it REALLY lands (`realPath`, which
       * follows the whole chain):
       *   - inside the repo but outside `node_modules` → a workspace package;
       *     re-point it at the worktree's own copy, which is the fix;
       *   - a container dir (`@scope`, `.bin`) → recurse, since it holds a mix;
       *   - anything else → a third-party package; link to the origin's copy and
       *     keep the anti-bloat win that motivated this in the first place.
       */
      const mirrorEntry = (
        repoPath: string,
        worktreePath: string,
        originDir: string,
        targetDir: string,
        name: string
      ): Effect.Effect<void, never, Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          const originEntry = path.join(originDir, name)
          const targetEntry = path.join(targetDir, name)

          // A broken link (a dep removed since the last install) resolves to
          // nothing. Skip it rather than propagating a dangling entry.
          const real = yield* fs.realPath(originEntry).pipe(Effect.option)
          if (real._tag === "None") return
          const resolved = real.value

          const nodeModulesRoot = path.join(repoPath, "node_modules")
          const insideRepo = isWithin(repoPath, resolved)
          const insideNodeModules = isWithin(nodeModulesRoot, resolved)

          if (insideRepo && !insideNodeModules) {
            // A workspace package. Point at the SAME relative location under the
            // worktree, so the branch's own source is what gets imported.
            const rel = path.relative(repoPath, resolved)
            yield* fs.symlink(path.join(worktreePath, rel), targetEntry).pipe(Effect.ignore)
            return
          }

          if (isContainerDir(name)) {
            yield* mirrorDir(repoPath, worktreePath, originEntry, targetEntry)
            return
          }

          yield* fs.symlink(originEntry, targetEntry).pipe(Effect.ignore)
        })

      /** Rebuild one directory in the worktree, mirroring each of its entries. */
      const mirrorDir = (
        repoPath: string,
        worktreePath: string,
        originDir: string,
        targetDir: string
      ): Effect.Effect<void, never, Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const entries = yield* fs.readDirectory(originDir).pipe(Effect.orElseSucceed(() => []))
          yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(Effect.ignore)
          yield* Effect.forEach(
            entries,
            (name) => mirrorEntry(repoPath, worktreePath, originDir, targetDir, name),
            // Bounded rather than unbounded: a large monorepo has thousands of
            // entries and each costs a `realPath` + a `symlink`. Sequential is
            // needlessly slow; unbounded exhausts the file-descriptor limit.
            { concurrency: 16, discard: true }
          )
        })

      /**
       * Anti-bloat: give the worktree a `node_modules` whose third-party packages
       * are SHARED with the origin repo (nothing copied or reinstalled) but whose
       * workspace packages resolve to the WORKTREE's own source. See
       * `mirrorEntry` for why the obvious one-symlink version was wrong.
       *
       * Best-effort throughout — a session with a partially-linked
       * `node_modules` is recoverable by running an install, but a session that
       * failed to create is not.
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
          if (!hasNodeModules) return
          // Canonicalise BOTH roots before any containment check. `realPath`
          // resolves symlinked parents, and on macOS the temp/volume paths that
          // repos live under routinely are ones (`/var` → `/private/var`). Left
          // uncanonicalised, a resolved workspace package never appears to be
          // "inside the repo", every entry falls through to the third-party
          // branch, and the bug this function fixes comes straight back — quietly.
          const repoRoot = yield* fs.realPath(repoPath).pipe(Effect.orElseSucceed(() => repoPath))
          const treeRoot = yield* fs
            .realPath(worktreePath)
            .pipe(Effect.orElseSucceed(() => worktreePath))
          yield* mirrorDir(
            repoRoot,
            treeRoot,
            originNodeModules,
            path.join(worktreePath, "node_modules")
          )
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
