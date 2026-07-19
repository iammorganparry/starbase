import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
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
