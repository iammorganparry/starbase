import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { unattendedSandbox, credentialDenyList } from "./sandbox.js"

describe("unattendedSandbox", () => {
  it("denies the credential locations that grant access to OTHER systems", () => {
    const deny = unattendedSandbox("/home/x").filesystem.denyRead
    expect(deny).toContain("/home/x/.ssh")
    expect(deny).toContain("/home/x/.aws")
    // The harnesses Starbase itself drives: an agent that read these could keep
    // running as the operator long after the session ended.
    expect(deny).toContain("/home/x/.claude/.credentials.json")
    expect(deny).toContain("/home/x/.codex/auth.json")
  })

  it("does NOT deny the home directory, which would deny the worktree too", () => {
    // Measured, not assumed: `denyRead` is absolute with no carve-out, so
    // denying `~` denies a worktree under `~` and the step cannot read its own
    // repository. This is why the protection is a denylist, not a boundary.
    expect(credentialDenyList("/home/x")).not.toContain("/home/x")
  })

  it("degrades rather than hard-failing an approved plan", () => {
    // `failIfUnavailable: true` would turn a missing platform dependency into
    // "your approved plan refuses to run". Wrong trade for defence-in-depth —
    // and the reason the pure file-tool check is kept as well.
    expect(unattendedSandbox("/home/x").failIfUnavailable).toBe(false)
  })

  it("auto-allows sandboxed commands, because nobody is there to approve them", () => {
    expect(unattendedSandbox("/home/x").autoAllowBashIfSandboxed).toBe(true)
  })
})
