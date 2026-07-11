import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { GhService } from "./gh.js"
import { fakeCommandExecutor, runExit } from "./test-support.js"
import type { FakeCommandHandler } from "./test-support.js"

/**
 * GhService parses `gh`'s output into a status the UI chip renders. `gh` may be
 * absent or unauthenticated in CI, so we drive it with canned command output and
 * assert the parsed outcome (available / authenticated / login / host / version).
 */
const GH = "/usr/local/bin/gh"

const AUTHED_OUTPUT = [
  "github.com",
  "  ✓ Logged in to github.com account octocat (keyring)",
  "  - Active account: true",
  "  - Git operations protocol: https"
].join("\n")

const run = (handler: FakeCommandHandler) =>
  runExit(GhService.status().pipe(Effect.provide(GhService.Default)), fakeCommandExecutor(handler))

describe("GhService.status", () => {
  it("reports unavailable when gh is not on PATH", async () => {
    const exit = await run((command) => (command === "which" ? { stdout: "" } : undefined))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.available).toBe(false)
      expect(exit.value.authenticated).toBe(false)
    }
  })

  it("reports authenticated with parsed login/host/version when gh auth exits 0", async () => {
    const exit = await run((command, args) => {
      if (command === "which") return { stdout: GH }
      if (args.includes("--version")) return { stdout: "gh version 2.68.1 (2024-11-27)" }
      if (args[0] === "auth") return { exitCode: 0, stdout: AUTHED_OUTPUT }
      return undefined
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toMatchObject({
      available: true,
      authenticated: true,
      login: "octocat",
      host: "github.com",
      version: "2.68.1"
    })
  })

  it("reports available-but-unauthenticated when gh auth exits non-zero", async () => {
    const exit = await run((command, args) => {
      if (command === "which") return { stdout: GH }
      if (args.includes("--version")) return { stdout: "gh version 2.68.1 (2024-11-27)" }
      if (args[0] === "auth") return { exitCode: 1, stderr: "You are not logged into any GitHub hosts." }
      return undefined
    })
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success") return
    expect(exit.value).toMatchObject({
      available: true,
      authenticated: false,
      login: null,
      version: "2.68.1"
    })
  })
})
