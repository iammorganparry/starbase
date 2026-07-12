import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GitService } from "./git.js"
import { initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

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

  it("symlinks node_modules to the origin repo when the origin has one", async () => {
    const repoPath = initGitRepo(join(repos.dir, "app"), { nodeModules: true })
    const exit = await create(repoPath, "app")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const link = join(exit.value.path, "node_modules")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // The marker in the origin's node_modules is readable *through* the link.
    expect(readFileSync(join(link, ".marker"), "utf-8")).toContain("origin-node-modules")
  })

  it("creates no node_modules link when the origin has none (and does not fail)", async () => {
    const repoPath = initGitRepo(join(repos.dir, "bare"))
    const exit = await create(repoPath, "bare")
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(existsSync(join(exit.value.path, "node_modules"))).toBe(false)
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
