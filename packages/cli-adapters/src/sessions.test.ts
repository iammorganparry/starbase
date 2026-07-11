import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CreateSessionInput } from "@starbase/core"
import { GitService } from "./git.js"
import { SessionStore } from "./sessions.js"
import { failureOf, initGitRepo, mkTemp, runExit, withTempRoot } from "./test-support.js"

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
})
