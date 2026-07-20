import type { ResolvingCommit, Worktree } from "@starbase/core"
import { GitError } from "@starbase/core"
import { relative, sep } from "node:path"
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
  // `sep`, not a hardcoded "/". `path.join` yields backslashes on Windows, so a
  // "/"-terminated prefix test is ALWAYS false there — which would classify
  // every workspace package as third-party and silently reinstate the exact
  // origin-resolution bug this file exists to fix. `confinement.ts` compares
  // paths the same way, for the same reason.
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Is `resolved` a WORKSPACE package of the repo at `repoRoot` — the repo's own
 * source, rather than an installed dependency?
 *
 * Tested as "inside the repo, with no `node_modules` segment on the way". The
 * segment check has to allow for nesting at ANY depth, not just the root
 * `node_modules`: pnpm gives each workspace package its own
 * `packages/<pkg>/node_modules`, so a root-only test would classify everything
 * installed there as repo source and re-point it at a path that holds no
 * package at all.
 *
 * Both arguments must already be canonical (see `linkNodeModules`).
 */
export const isWorkspacePath = (repoRoot: string, resolved: string): boolean => {
  if (!isWithin(repoRoot, resolved)) return false
  // `relative` + split on `sep` rather than slicing and splitting on "/", so the
  // segment test holds on Windows too. See `isWithin`.
  const rel = relative(repoRoot, resolved)
  return rel.length > 0 && !rel.split(sep).includes("node_modules")
}

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
       * Build caches that live inside `node_modules`. Deliberately NOT shared.
       *
       * These are written during ordinary work, not during install, so linking
       * one would hand every parallel session the same directory to write
       * concurrently — cross-contaminating one branch's build output with
       * another's. They are also cheap to regenerate, which is the whole reason
       * a tool put its cache somewhere disposable.
       */
      const CACHE_DIRS: ReadonlySet<string> = new Set([".cache", ".vite", ".turbo", ".parcel-cache"])

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
        name: string,
        /** Real paths already being mirrored on this branch — the cycle guard. */
        seen: Set<string>,
        /**
         * Is `originDir` a `node_modules` ROOT, rather than a container dir
         * inside one? Only a root holds install metadata worth copying — see the
         * copy branch below, which is actively harmful anywhere else.
         */
        atRoot: boolean
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

          // A cache, not a dependency. Left absent so the worktree makes its own.
          if (CACHE_DIRS.has(name)) return

          if (isWorkspacePath(repoPath, resolved)) {
            // A workspace package. Point at the SAME relative location under the
            // worktree, so the branch's own source is what gets imported.
            const rel = path.relative(repoPath, resolved)
            yield* fs.symlink(path.join(worktreePath, rel), targetEntry).pipe(Effect.ignore)
            return
          }

          if (isContainerDir(name)) {
            yield* mirrorDir(repoPath, worktreePath, originEntry, targetEntry, seen, false)
            return
          }

          // A regular FILE at a node_modules ROOT — install metadata like
          // `.yarn-state.yml`, `.package-lock.json`, `.modules.yaml`. Copied,
          // never linked: these are the files a package manager REWRITES, and
          // the recovery flow this whole design assumes ("a session that changes
          // deps just installs over the links") opens exactly them for write.
          // Linked, that write follows the symlink and rewrites the ORIGIN's
          // install state to describe the worktree's tree — corrupting the
          // source repo from a session that did nothing wrong. A few KB each.
          //
          // `atRoot` is load-bearing, not a tidy-up. Inside `.bin` every entry
          // ALSO resolves to a file — the package's executable script — and
          // copying one strands it: a shim reached at `.bin/tsc` resolves its
          // own `require("../lib/tsc.js")` against `.bin/`, so every third-party
          // CLI an agent runs (`tsc`, `eslint`, anything behind a package
          // script) dies with MODULE_NOT_FOUND. Those must stay symlinks, which
          // resolve back to the real script inside its own package.
          if (atRoot) {
            const info = yield* fs.stat(resolved).pipe(Effect.option)
            if (info._tag === "Some" && info.value.type === "File") {
              yield* fs.copyFile(originEntry, targetEntry).pipe(Effect.ignore)
              return
            }
          }

          yield* fs.symlink(originEntry, targetEntry).pipe(Effect.ignore)
        })

      /**
       * Rebuild one directory in the worktree, mirroring each of its entries.
       *
       * `seen` holds the REAL paths already being mirrored on this branch of the
       * recursion. Without it, a container-dir symlink pointing at its own
       * ancestor (`node_modules/@a -> .`) re-lists the same tree forever: session
       * creation hangs or blows the stack, losing an operation everything else
       * here is careful to make unfailable. Contrived, but nothing prevents it,
       * and the cost of the guard is one Set.
       */
      const mirrorDir = (
        repoPath: string,
        worktreePath: string,
        originDir: string,
        targetDir: string,
        seen: Set<string>,
        /** True only for a `node_modules` root — see `mirrorEntry`'s copy branch. */
        atRoot: boolean
      ): Effect.Effect<void, never, Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          // Keyed on the resolved path, so two routes to one directory count as
          // the same visit — which is exactly what a cycle is.
          const real = yield* fs.realPath(originDir).pipe(Effect.orElseSucceed(() => originDir))
          if (seen.has(real)) return
          seen.add(real)
          const entries = yield* fs.readDirectory(originDir).pipe(Effect.orElseSucceed(() => []))
          yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(Effect.ignore)
          yield* Effect.forEach(
            entries,
            (name) => mirrorEntry(repoPath, worktreePath, originDir, targetDir, name, seen, atRoot),
            // Bounded rather than unbounded: a large monorepo has thousands of
            // entries and each costs a `realPath` + a `symlink`. Sequential is
            // needlessly slow; unbounded exhausts the file-descriptor limit.
            { concurrency: 16, discard: true }
          )
        })

      /**
       * Repo-relative directories that hold their own `node_modules` — the
       * per-package installs pnpm and nested-npm layouts create.
       *
       * Found by scanning rather than by parsing workspace globs, because the
       * globs live in a different file per package manager (`pnpm-workspace.yaml`,
       * `package.json#workspaces`, `lerna.json`) and a scan is correct for all of
       * them. Bounded to two levels (`packages/core`, `apps/desktop`) — deeper
       * nesting is rare, and the alternative is walking a whole monorepo.
       */
      const nestedNodeModules = (
        repoPath: string
      ): Effect.Effect<ReadonlyArray<string>, never, Path.Path | FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fs = yield* FileSystem.FileSystem
          const groups = yield* fs.readDirectory(repoPath).pipe(Effect.orElseSucceed(() => []))
          const found: Array<string> = []
          for (const group of groups) {
            // Never descend into the root install: its `.pnpm` store alone holds
            // thousands of nested `node_modules`, none of them workspace packages.
            if (group === "node_modules" || group.startsWith(".")) continue
            const groupPath = path.join(repoPath, group)
            const members = yield* fs.readDirectory(groupPath).pipe(Effect.orElseSucceed(() => []))
            for (const member of members) {
              const rel = path.join(group, member)
              const has = yield* fs
                .exists(path.join(repoPath, rel, "node_modules"))
                .pipe(Effect.orElseSucceed(() => false))
              if (has) found.push(rel)
            }
          }
          return found
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
          // A FRESH visited-set per top-level mirror. Sharing one across the
          // per-package installs below would treat a directory legitimately
          // reached from two different packages as a cycle and skip it the
          // second time, leaving that package's deps unmirrored.
          yield* mirrorDir(
            repoRoot,
            treeRoot,
            originNodeModules,
            path.join(worktreePath, "node_modules"),
            new Set(),
            true
          )
          // pnpm (and npm with nested installs) give each workspace package its
          // OWN node_modules — `packages/<pkg>/node_modules` — holding that
          // package's deps and its links to sibling workspaces. They are
          // gitignored, so a fresh worktree checkout has none of them, and
          // mirroring only the root would leave every import from inside
          // `packages/*` unresolved on the layout this product itself uses.
          for (const dir of yield* nestedNodeModules(repoPath)) {
            yield* mirrorDir(
              repoRoot,
              treeRoot,
              path.join(repoPath, dir, "node_modules"),
              path.join(worktreePath, dir, "node_modules"),
              new Set(),
              true
            )
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
