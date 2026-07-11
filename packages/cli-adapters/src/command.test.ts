import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { expandHome, runGit } from "./command.js"
import { failureOf, fakeCommandExecutor, runExit } from "./test-support.js"

/**
 * The shared command helpers are a real module boundary (git/gh/discovery all
 * build on them), so their contract is worth asserting directly: how `~` is
 * expanded, and that `runGit` fails with the stderr message on a non-zero exit.
 */
describe("expandHome", () => {
  const original = process.env.HOME
  beforeEach(() => {
    process.env.HOME = "/home/tester"
  })
  afterEach(() => {
    process.env.HOME = original
  })

  it("expands a leading ~ to the home directory", async () => {
    expect(await Effect.runPromise(expandHome("~/repos"))).toBe("/home/tester/repos")
  })

  it("leaves an absolute path untouched", async () => {
    expect(await Effect.runPromise(expandHome("/opt/tools"))).toBe("/opt/tools")
  })

  it("only expands a tilde at the start, not mid-string", async () => {
    expect(await Effect.runPromise(expandHome("/x/~/y"))).toBe("/x/~/y")
  })
})

describe("runGit", () => {
  it("returns trimmed stdout on success", async () => {
    const exit = await runExit(
      runGit(null, ["rev-parse", "HEAD"]),
      fakeCommandExecutor(() => ({ exitCode: 0, stdout: "deadbeef\n" }))
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBe("deadbeef")
  })

  it("fails with a GitError carrying the stderr message on non-zero exit", async () => {
    const exit = await runExit(
      runGit(null, ["worktree", "add", "bad"]),
      fakeCommandExecutor(() => ({ exitCode: 128, stderr: "fatal: invalid reference: bad" }))
    )
    expect(exit._tag).toBe("Failure")
    const err = failureOf(exit)
    expect(err?._tag).toBe("GitError")
    expect(err?.message).toBe("fatal: invalid reference: bad")
  })
})
