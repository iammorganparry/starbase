import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GitService } from "./git.js"
import { advanceOrigin, initGitRepo, initGitRepoWithOrigin, mkTemp, runExit, withTempRoot } from "./test-support.js"

/**
 * GitService.createWorktree runs real `git worktree add`. We assert the real
 * outcomes on disk — the worktree exists, the branch was created, git tracks the
 * worktree, and node_modules is (or isn't) symlinked — not the git invocations.
 */
describe("GitService.createWorktree", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("starbase-repos-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const create = (repoPath: string, repoName: string) =>
    runExit(
      GitService.createWorktree({ repoPath, repoName, slug: "fix-auth", baseBranch: "main" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )

  it("creates the worktree on a fresh starbase/<slug> branch", async () => {
    const repoPath = initGitRepo(join(repos.dir, "widget"))
    const exit = await create(repoPath, "widget")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const worktree = exit.value
    expect(worktree.branch).toBe("starbase/fix-auth")
    expect(worktree.path).toBe(join(temp.root, "worktrees", "widget", "fix-auth"))
    expect(existsSync(worktree.path)).toBe(true)

    const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(branches).toContain("starbase/fix-auth")

    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(worktrees).toContain(worktree.path)
  })

  it("shares the origin's third-party packages rather than copying them", async () => {
    const repoPath = initGitRepo(join(repos.dir, "app"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "app")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const nm = join(exit.value.path, "node_modules")

    // The anti-bloat win, and the reason the whole design exists: a dependency
    // DIRECTORY is linked, not duplicated. Bulk is shared; only the small
    // metadata files are copied (see the install-state test).
    expect(lstatSync(join(nm, "left-pad")).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(nm, "left-pad", "index.js"), "utf-8")).toContain("vendor")
    // Contents remain readable from the worktree either way.
    expect(readFileSync(join(nm, ".marker"), "utf-8")).toContain("origin-node-modules")
  })

  it("resolves a WORKSPACE package to the worktree's own source, not the origin's", async () => {
    // The regression this whole mirror exists for. A package manager writes
    // workspace links RELATIVE (`@acme/lib -> ../../packages/lib`), so
    // symlinking node_modules wholesale made every workspace import in the
    // worktree resolve back into the ORIGIN checkout. Agents then edited the
    // branch and type-checked main.
    const repoPath = initGitRepo(join(repos.dir, "mono"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "mono")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const worktree = exit.value.path

    // Change the branch's copy. The origin's copy still says "origin-source".
    writeFileSync(join(worktree, "packages", "lib", "index.js"), "module.exports = 'branch-source'\n")

    const throughLink = readFileSync(join(worktree, "node_modules", "@acme", "lib", "index.js"), "utf-8")
    expect(throughLink).toContain("branch-source")
    expect(throughLink).not.toContain("origin-source")
    // And the origin is untouched — the worktree must not write through to it.
    expect(readFileSync(join(repoPath, "packages", "lib", "index.js"), "utf-8")).toContain("origin-source")
  })

  it("tells workspace and third-party apart INSIDE the same scope dir", async () => {
    // `@acme` holds both a workspace link and a vendored package, so the scope
    // dir can't be classified as a whole — only entry by entry.
    const repoPath = initGitRepo(join(repos.dir, "mixed"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "mixed")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const nm = join(exit.value.path, "node_modules")

    // The scope dir itself is REAL (rebuilt), or its entries couldn't differ.
    expect(lstatSync(join(nm, "@acme")).isDirectory()).toBe(true)
    expect(lstatSync(join(nm, "@acme")).isSymbolicLink()).toBe(false)
    // Vendored code is still shared with the origin.
    expect(readFileSync(join(nm, "@acme", "vendor-kit", "index.js"), "utf-8")).toContain("vendor")
    expect(readFileSync(join(nm, "left-pad", "index.js"), "utf-8")).toContain("vendor")
  })

  it("COPIES install state, so an install in the worktree can't rewrite the origin's", async () => {
    // The recovery flow this design assumes — "a session that changes deps just
    // installs over the links" — opens exactly these files for write. Linked,
    // that write follows the symlink and rewrites the ORIGIN's install state to
    // describe the worktree's tree, corrupting the source repo from a session
    // that did nothing wrong.
    const repoPath = initGitRepo(join(repos.dir, "state"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "state")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const stateFile = join(exit.value.path, "node_modules", ".install-state.yml")
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(false)
    writeFileSync(stateFile, "worktree-state\n")
    expect(readFileSync(join(repoPath, "node_modules", ".install-state.yml"), "utf-8")).toContain(
      "origin-state"
    )
  })

  it("leaves build caches out entirely rather than sharing one between branches", async () => {
    // A cache is written during ordinary work, not install — sharing it hands
    // every parallel session the same dir to write concurrently.
    const repoPath = initGitRepo(join(repos.dir, "cache"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "cache")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(join(exit.value.path, "node_modules", ".cache"))).toBe(false)
  })

  it("mirrors PER-PACKAGE node_modules, so a pnpm layout resolves too", async () => {
    // pnpm gives each workspace package its own node_modules. They're gitignored,
    // so a fresh worktree checkout has none — mirroring only the root would leave
    // every import from inside `packages/*` unresolved on the layout this product
    // itself uses.
    const repoPath = initGitRepo(join(repos.dir, "pnpm"), { nodeModules: true, workspace: true })
    const exit = await create(repoPath, "pnpm")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const libNm = join(exit.value.path, "packages", "lib", "node_modules")

    // Its third-party dep is shared with the origin …
    expect(readFileSync(join(libNm, "dep-of-lib", "index.js"), "utf-8")).toContain("vendor")
    // … and its link to a SIBLING workspace package follows the branch, which is
    // the same rule the root mirror applies, applied one level down.
    writeFileSync(join(exit.value.path, "packages", "app", "index.js"), "module.exports = 'branch-app'\n")
    expect(readFileSync(join(libNm, "@acme", "app", "index.js"), "utf-8")).toContain("branch-app")
  })

  it("walks a scope dir that links to its own ancestor exactly once", async () => {
    // `node_modules/@loop -> .` resolves to node_modules itself: it isn't a
    // workspace path, and it matches isContainerDir, so an unguarded mirror
    // recurses into the same tree again.
    //
    // It does NOT hang — the kernel's symlink-loop detection returns ELOOP at
    // ~31 levels and the read folds to empty. What it does instead is quietly
    // build 31 levels of junk directories in the worktree, because each level
    // creates its target before discovering there's nothing to put in it. The
    // visited-set stops it at the first repeat.
    const repoPath = initGitRepo(join(repos.dir, "loop"), { nodeModules: true })
    symlinkSync(".", join(repoPath, "node_modules", "@loop"))

    const exit = await create(repoPath, "loop")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const nm = join(exit.value.path, "node_modules")

    // Visited once: the scope dir exists, but nothing was mirrored THROUGH it.
    expect(existsSync(join(nm, "@loop", "@loop"))).toBe(false)
    // And the healthy entries still landed — the guard skips the cycle, not the run.
    expect(existsSync(join(nm, ".marker"))).toBe(true)
  })

  it("survives a broken link in the origin's node_modules", async () => {
    // A dep removed since the last install leaves a dangling entry. It must be
    // skipped, not propagated — and must not fail the session create, which is
    // the expensive thing to lose.
    const repoPath = initGitRepo(join(repos.dir, "stale"), { nodeModules: true })
    symlinkSync(join(repoPath, "node_modules", "gone"), join(repoPath, "node_modules", "dangling"))
    const exit = await create(repoPath, "stale")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(join(exit.value.path, "node_modules", "dangling"))).toBe(false)
    // The healthy entries still landed.
    expect(existsSync(join(exit.value.path, "node_modules", ".marker"))).toBe(true)
  })

  it("creates no node_modules link when the origin has none (and does not fail)", async () => {
    const repoPath = initGitRepo(join(repos.dir, "bare"))
    const exit = await create(repoPath, "bare")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(join(exit.value.path, "node_modules"))).toBe(false)
  })

  it("removeWorktreeAt deletes a worktree and unregisters it from the origin repo", async () => {
    const repoPath = initGitRepo(join(repos.dir, "rm"))
    const created = await create(repoPath, "rm")
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const worktreePath = created.value.path
    expect(existsSync(worktreePath)).toBe(true)

    const removed = await runExit(
      GitService.removeWorktreeAt(worktreePath).pipe(Effect.provide(GitService.Default)),
      temp.layer
    )
    expect(removed._tag).toBe("Success")
    expect(existsSync(worktreePath)).toBe(false)
    const list = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(list).not.toContain(worktreePath)
  })

  it("forks off the fresh remote tip — a session picks up commits the local clone hadn't fetched", async () => {
    // A real clone with a bare origin, then push a commit to origin the clone
    // hasn't seen. createWorktree must fetch + fork off origin/main, not stale local.
    const repoPath = join(repos.dir, "fresh")
    const { origin } = initGitRepoWithOrigin(repoPath)
    advanceOrigin(origin, "remote-only-commit")

    const exit = await create(repoPath, "fresh")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    // The worktree contains the origin-only commit …
    const worktreeLog = execFileSync("git", ["log", "--format=%s"], {
      cwd: exit.value.path,
      encoding: "utf-8"
    })
    expect(worktreeLog).toContain("remote-only-commit")
    // … which the clone's local `main` still hasn't (we forked off origin/main).
    const localLog = execFileSync("git", ["log", "main", "--format=%s"], {
      cwd: repoPath,
      encoding: "utf-8"
    })
    expect(localLog).not.toContain("remote-only-commit")
  })

  it("still creates the worktree when origin is unreachable (fetch is best-effort)", async () => {
    // A URL-only remote: `git fetch origin main` will fail, but creation must not.
    const repoPath = initGitRepo(join(repos.dir, "offline"), {
      remote: "https://example.invalid/nope.git"
    })
    const exit = await create(repoPath, "offline")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(exit.value.path)).toBe(true)
    expect(exit.value.branch).toBe("starbase/fix-auth")
  })

  it("forks off a local-only base branch when there is no matching remote ref", async () => {
    // `feature-x` is a purely local branch: no `origin/feature-x`, so the fetch is
    // a no-op and we fall back to forking off the local branch.
    const repoPath = initGitRepo(join(repos.dir, "localbase"), { branches: ["feature-x"] })
    const exit = await runExit(
      GitService.createWorktree({ repoPath, repoName: "localbase", slug: "off-x", baseBranch: "feature-x" }).pipe(
        Effect.provide(GitService.Default)
      ),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(exit.value.path)).toBe(true)
    expect(exit.value.baseBranch).toBe("feature-x")
  })

  it("createDetachedWorktree reclaims a leftover worktree at the same path (retry-safe)", async () => {
    const repoPath = initGitRepo(join(repos.dir, "retry"))
    const detached = () =>
      runExit(
        GitService.createDetachedWorktree({
          repoPath,
          repoName: "retry",
          slug: "from-pr",
          baseBranch: "main"
        }).pipe(Effect.provide(GitService.Default)),
        temp.layer
      )

    // First attempt leaves a real detached worktree on disk (mimicking a create
    // that failed AFTER the worktree add — e.g. gh pr checkout errored).
    const first = await detached()
    expect(first._tag).toBe("Success")
    if (first._tag !== "Success") return
    expect(existsSync(first.value.path)).toBe(true)

    // A retry at the same slug must reclaim the stale worktree, not fail with
    // "already exists".
    const second = await detached()
    expect(second._tag).toBe("Success")
    if (second._tag !== "Success") return
    expect(second.value.path).toBe(first.value.path)
    expect(existsSync(second.value.path)).toBe(true)

    // git tracks exactly one worktree at that path (no stale duplicate).
    const list = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    const occurrences = list.split("\n").filter((l) => l.includes(second.value.path)).length
    expect(occurrences).toBe(1)
  })
})

/**
 * `commitsSince` feeds review-finding attribution: the first commit touching a
 * finding's file is credited with fixing it. So the two things worth asserting
 * against real git are the ORDER (oldest first — the contract the credit rule
 * depends on) and the per-commit file lists the match is made against.
 */
describe("GitService.commitsSince", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("starbase-repos-")
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" })

  const commit = (dir: string, file: string, message: string) => {
    writeFileSync(join(dir, file), `${message}\n`)
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-m", message, "--no-gpg-sign"])
  }

  const since = (cwd: string, sha: string) =>
    runExit(GitService.commitsSince(cwd, sha).pipe(Effect.provide(GitService.Default)), temp.layer)

  it("lists commits oldest-first with the files each touched", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    commit(dir, "a.ts", "first")
    commit(dir, "b.ts", "second")

    const exit = await since(dir, base)
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value.map((c) => c.subject)).toStrictEqual(["first", "second"])
    expect(exit.value.map((c) => c.files)).toStrictEqual([["a.ts"], ["b.ts"]])
    expect(exit.value[0]!.sha).toHaveLength(40)
  })

  it("lists every file a single commit touched", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    writeFileSync(join(dir, "a.ts"), "a\n")
    writeFileSync(join(dir, "b.ts"), "b\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-m", "both", "--no-gpg-sign"])

    const exit = await since(dir, base)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value).toHaveLength(1)
    expect([...exit.value[0]!.files].sort()).toStrictEqual(["a.ts", "b.ts"])
  })

  it("is empty when nothing has landed since the head", async () => {
    const dir = initGitRepo(join(repos.dir, "widget"))
    const head = git(dir, ["rev-parse", "HEAD"]).trim()
    const exit = await since(dir, head)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value).toStrictEqual([])
  })

  it("folds an unknown SHA to empty rather than failing", async () => {
    // The real case: the reviewed head was force-pushed away, so the object is
    // gone from this worktree. Declining to attribute is the safe direction — a
    // crashed review pane is not.
    const dir = initGitRepo(join(repos.dir, "widget"))
    const exit = await since(dir, "0000000000000000000000000000000000000000")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toStrictEqual([])
  })

  it("keeps a subject containing punctuation intact", async () => {
    // The parse splits on a unit separator, not on ':' or '-', so a conventional
    // commit subject survives whole.
    const dir = initGitRepo(join(repos.dir, "widget"))
    const base = git(dir, ["rev-parse", "HEAD"]).trim()
    commit(dir, "a.ts", "fix(auth): compare tokens with timingSafeEqual - not ===")

    const exit = await since(dir, base)
    if (exit._tag !== "Success") throw new Error("expected success")
    expect(exit.value[0]!.subject).toBe("fix(auth): compare tokens with timingSafeEqual - not ===")
  })
})
