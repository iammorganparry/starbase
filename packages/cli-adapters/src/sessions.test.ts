import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CreateSessionFromPrInput, CreateSessionInput } from "@starbase/core"
import { GhService } from "./gh.js"
import { GitService } from "./git.js"
import { SessionStore } from "./sessions.js"
import {
  failureOf,
  fakeCommandExecutor,
  initGitRepo,
  mkTemp,
  runExit,
  withTempRoot
} from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * SessionStore persists sessions to disk and forks a real worktree per session.
 * We assert the outcomes a user sees: the session's shape, that new sessions lead
 * the list, that they survive a fresh read (persistence), and that a missing id
 * fails with the typed error. The slug rule is checked only via `session.branch`.
 */
describe("SessionStore", () => {
  let temp: ReturnType<typeof withTempRoot>
  let repos: ReturnType<typeof mkTemp>
  let repoPath: string
  beforeEach(() => {
    temp = withTempRoot()
    repos = mkTemp("starbase-repos-")
    repoPath = initGitRepo(join(repos.dir, "trigify-app"))
  })
  afterEach(() => {
    temp.cleanup()
    repos.cleanup()
  })

  const services = Layer.mergeAll(SessionStore.Default, GitService.Default)

  const input = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
    repoPath,
    repoName: "trigify-app",
    title: "Fix Login Bug!",
    cli: "claude",
    baseBranch: "main",
    ...over
  })

  it("creates an idle session with a starbase/<slug> branch and a worktree path", async () => {
    const exit = await runExit(
      SessionStore.create(input()).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const s = exit.value
    expect(s.status).toBe("idle")
    expect(s.branch).toBe("starbase/fix-login-bug")
    expect(s.baseBranch).toBe("main")
    expect(s.worktreePath).toBe(join(temp.root, "worktrees", "trigify-app", "fix-login-bug"))
    expect(s.diff).toStrictEqual({ added: 0, removed: 0 })
  })

  it("stamps the provider's default mode + model when supplied (else leaves them unset)", async () => {
    const withDefaults = await runExit(
      SessionStore.create(input(), { defaultMode: "plan", defaultModel: "opus" }).pipe(
        Effect.provide(services)
      ),
      temp.layer
    )
    expect(withDefaults._tag).toBe("Success")
    if (withDefaults._tag === "Success") {
      expect(withDefaults.value.mode).toBe("plan")
      expect(withDefaults.value.model).toBe("opus")
    }

    const noDefaults = await runExit(
      SessionStore.create(input({ title: "No Defaults" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(noDefaults._tag).toBe("Success")
    if (noDefaults._tag === "Success") {
      expect(noDefaults.value.mode).toBeUndefined()
      expect(noDefaults.value.model).toBeUndefined()
    }
  })

  it("falls back to the 'session' slug when the title has no alphanumerics", async () => {
    const exit = await runExit(
      SessionStore.create(input({ title: "!!!" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.branch).toBe("starbase/session")
  })

  it("prepends new sessions and persists them across a fresh read", async () => {
    const created = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.create(input({ title: "First" }))
        yield* SessionStore.create(input({ title: "Second" }))
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")

    // Fresh provide → reads sessions.json from disk (proves persistence).
    const listed = await runExit(
      SessionStore.list().pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(listed._tag).toBe("Success")
    if (listed._tag === "Success") {
      expect(listed.value.map((s) => s.title)).toStrictEqual(["Second", "First"])
    }
  })

  it("fails with SessionNotFoundError for an unknown id", async () => {
    const exit = await runExit(
      SessionStore.get("s_nope").pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(exit._tag).toBe("Failure")
    expect(failureOf(exit)?._tag).toBe("SessionNotFoundError")
  })

  it("setPrNumber links (and clears) a session's PR across a fresh read", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "PR Session" }))
        yield* SessionStore.setPrNumber(created.id, 482)
        return created.id
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const id = exit.value

    const linked = await runExit(
      SessionStore.get(id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(linked._tag === "Success" && linked.value.prNumber).toBe(482)

    // Clearing it (null) round-trips too.
    const cleared = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.setPrNumber(id, null)
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(cleared._tag === "Success" && cleared.value.prNumber).toBe(null)
  })

  it("setMode / setModel persist onto the session across a fresh read", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const created = yield* SessionStore.create(input({ title: "Configurable" }))
        yield* SessionStore.setMode(created.id, "auto")
        yield* SessionStore.setModel(created.id, "sonnet")
        return created.id
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return

    const reread = await runExit(
      SessionStore.get(exit.value).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag).toBe("Success")
    if (reread._tag === "Success") {
      expect(reread.value.mode).toBe("auto")
      expect(reread.value.model).toBe("sonnet")
    }
  })

  // `createFromPr` orchestrates real GitService (worktree add) + GhService
  // (`gh pr checkout`). `gh` isn't available in CI and the fork isn't real, so we
  // drive both binaries with a fake executor overlaid on the real temp FS: the
  // worktree dir + sessions.json are real, only the git/gh *processes* are canned.
  const prServices = Layer.mergeAll(SessionStore.Default, GitService.Default, GhService.Default)

  const prInput = (over: Partial<CreateSessionFromPrInput["pr"]> = {}): CreateSessionFromPrInput => ({
    repoPath,
    repoName: "trigify-app",
    cli: "claude",
    pr: { number: 482, title: "Fix Auth Refresh", headRefName: "chore/bump", baseRefName: "main", ...over }
  })

  /** Fake git/gh: record the argv, echo `headBranch` for rev-parse. */
  const prExecutor = (headBranch: string, calls: Array<string>): FakeCommandHandler => (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`)
    if (cmd === "gh") return { stdout: "" }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: headBranch }
    return { exitCode: 0, stdout: "" }
  }

  it("createFromPr checks out the PR head branch and links the PR number", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(prExecutor("chore/bump", calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput()).pipe(Effect.provide(prServices)),
      env
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    const s = exit.value
    expect(s.prNumber).toBe(482)
    expect(s.branch).toBe("chore/bump") // the live branch after `gh pr checkout`
    expect(s.baseBranch).toBe("main")
    expect(s.title).toBe("Fix Auth Refresh")
    expect(s.worktreePath).toBe(join(temp.root, "worktrees", "trigify-app", "fix-auth-refresh"))

    // Sequence: detached worktree → gh pr checkout → resolve the head branch.
    const detach = calls.findIndex((c) => c.includes("worktree add --detach"))
    const checkout = calls.findIndex((c) => c.startsWith("gh pr checkout 482"))
    const revparse = calls.findIndex((c) => c.includes("rev-parse"))
    expect(detach).toBeGreaterThanOrEqual(0)
    expect(checkout).toBeGreaterThan(detach)
    expect(revparse).toBeGreaterThan(checkout)

    // Persisted across a fresh read.
    const reread = await runExit(
      SessionStore.get(s.id).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(reread._tag === "Success" && reread.value.prNumber).toBe(482)
  })

  it("createFromPr falls back to the PR head ref when HEAD is detached", async () => {
    const calls: Array<string> = []
    // "HEAD" (detached) → branchAt yields null → the reported head ref is used.
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(prExecutor("HEAD", calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput({ headRefName: "feat/from-fork" })).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(exit._tag === "Success" && exit.value.branch).toBe("feat/from-fork")
  })

  it("createFromPr fails with GhError when `gh pr checkout` fails", async () => {
    const handler: FakeCommandHandler = (cmd, args) =>
      cmd === "gh" && args[1] === "checkout" ? { exitCode: 1, stderr: "gh: no such PR" } : { stdout: "" }
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(handler))
    const exit = await runExit(
      SessionStore.createFromPr(prInput()).pipe(Effect.provide(prServices)),
      env
    )
    expect(failureOf(exit)?._tag).toBe("GhError")
  })

  // When the PR head branch is already checked out elsewhere, `gh pr checkout`
  // fails with git's "already checked out" error. The share-checked-out lever
  // decides whether to fall back to a shared checkout or surface the error.
  const alreadyCheckedOut = (calls: Array<string>): FakeCommandHandler => (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`)
    if (cmd === "gh" && args[1] === "checkout") {
      return { exitCode: 1, stderr: "fatal: 'chore/bump' is already checked out at '/repo'" }
    }
    if (cmd === "git" && args.includes("rev-parse")) return { stdout: "chore/bump" }
    return { exitCode: 0, stdout: "" }
  }

  it("createFromPr falls back to a shared checkout when allowSharedCheckout is on", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(alreadyCheckedOut(calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput(), { allowSharedCheckout: true }).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value.branch).toBe("chore/bump")
    // It retried with the ignore-other-worktrees checkout after gh failed.
    expect(calls.some((c) => c.includes("checkout --ignore-other-worktrees chore/bump"))).toBe(true)
  })

  it("archive sets archived + reason + archivedAt; restore clears them", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Archive Me" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const id = created.value.id

    const archived = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.archive(id, "merged")
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(archived._tag).toBe("Success")
    if (archived._tag === "Success") {
      expect(archived.value.archived).toBe(true)
      expect(archived.value.archiveReason).toBe("merged")
      expect(typeof archived.value.archivedAt).toBe("string")
    }

    const restored = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.restore(id)
        return yield* SessionStore.get(id)
      }).pipe(Effect.provide(SessionStore.Default)),
      temp.layer
    )
    expect(restored._tag).toBe("Success")
    if (restored._tag === "Success") {
      expect(restored.value.archived).toBe(false)
      expect(restored.value.archiveReason).toBeUndefined()
    }
  })

  it("remove deletes the session record and its worktree", async () => {
    const created = await runExit(
      SessionStore.create(input({ title: "Delete Me" })).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(created._tag).toBe("Success")
    if (created._tag !== "Success") return
    const worktreePath = created.value.worktreePath!
    expect(existsSync(worktreePath)).toBe(true)

    const removed = await runExit(
      Effect.gen(function* () {
        yield* SessionStore.remove(created.value.id)
        return yield* SessionStore.list()
      }).pipe(Effect.provide(services)),
      temp.layer
    )
    expect(removed._tag).toBe("Success")
    if (removed._tag === "Success") {
      expect(removed.value.some((s) => s.id === created.value.id)).toBe(false)
    }
    // The worktree was removed from disk + unregistered in the origin repo.
    expect(existsSync(worktreePath)).toBe(false)
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repoPath, encoding: "utf-8" })
    expect(worktrees).not.toContain(worktreePath)
  })

  it("createFromPr surfaces the error when allowSharedCheckout is off", async () => {
    const calls: Array<string> = []
    const env = Layer.mergeAll(temp.layer, fakeCommandExecutor(alreadyCheckedOut(calls)))
    const exit = await runExit(
      SessionStore.createFromPr(prInput(), { allowSharedCheckout: false }).pipe(
        Effect.provide(prServices)
      ),
      env
    )
    expect(failureOf(exit)?._tag).toBe("GhError")
    expect(calls.some((c) => c.includes("--ignore-other-worktrees"))).toBe(false)
  })
})
