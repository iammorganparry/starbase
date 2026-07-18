import { homedir } from "node:os"
import { describe, expect, it } from "vitest"
import { neutralCwd, requireWorktree } from "./cwd.js"

/**
 * Cross-repo containment.
 *
 * Starbase runs many repos side by side, each session in its own worktree. The
 * failure this guards against is real and already happened: a user-scope MCP
 * server probed from Settings had no worktree, was spawned with no cwd, inherited
 * the Electron main process's working directory — which in development is
 * whichever worktree `pnpm dev` was launched from — and wrote its SQLite database
 * into an unrelated repo's checkout, where it surfaced as an untracked file in
 * that repo's PR.
 *
 * The invariant: NO spawn ever inherits the app's cwd. Either a real worktree, or
 * an explicitly neutral directory that belongs to no repo.
 */

describe("requireWorktree", () => {
  it("returns a real worktree path unchanged", () => {
    expect(requireWorktree("/Users/me/starbase/worktrees/app/feat", "session s1")).toBe(
      "/Users/me/starbase/worktrees/app/feat"
    )
  })

  it("trims incidental whitespace rather than treating it as a path", () => {
    expect(requireWorktree("  /tmp/wt  ", "session s1")).toBe("/tmp/wt")
  })

  for (const [label, value] of [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined]
  ] as const) {
    it(`throws on ${label} instead of falling back to the app's cwd`, () => {
      // The whole point. The only available fallback is `process.cwd()`, which
      // would silently run this session against an unrelated repository — so an
      // absent worktree has to be an error, not a default.
      expect(() => requireWorktree(value, "session s1")).toThrow(/no worktree/i)
    })
  }

  it("names what is missing a worktree, so the error is actionable", () => {
    expect(() => requireWorktree("", "session s_abc")).toThrow(/session s_abc/)
  })

  it("never returns the process working directory", () => {
    // Stated directly: whatever this function does, it must not resolve to the
    // app's own directory.
    expect(() => requireWorktree("", "session s1")).toThrow()
    expect(requireWorktree(process.cwd(), "session s1")).toBe(process.cwd())
  })
})

describe("neutralCwd", () => {
  it("is the user's home — a directory that is never a checkout", () => {
    expect(neutralCwd()).toBe(homedir())
  })

  it("is not the app's working directory", () => {
    // In development the app's cwd IS a repo checkout, which is precisely what a
    // process with no session must never be pointed at.
    expect(neutralCwd()).not.toBe(process.cwd())
  })
})
