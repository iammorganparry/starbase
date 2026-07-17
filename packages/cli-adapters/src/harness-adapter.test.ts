import type { CliKind } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { forgetForeignResume, selectHarness } from "./harness-adapter.js"

/**
 * The dispatcher must send each turn to the right place — the real Claude adapter
 * only when a `claude` binary exists and scripted isn't forced. We assert that
 * routing decision (the behaviour that determines whether a real process runs).
 */
describe("selectHarness", () => {
  it("routes an installed claude to the real adapter", () => {
    expect(selectHarness("claude", "/usr/bin/claude", false)).toBe("claude")
  })

  it("routes an installed codex to the real adapter", () => {
    expect(selectHarness("codex", "/usr/bin/codex", false)).toBe("codex")
  })

  it("routes an installed opencode to the real adapter", () => {
    expect(selectHarness("opencode", "/opt/homebrew/bin/opencode", false)).toBe("opencode")
  })

  it("falls back to scripted when the binary is missing", () => {
    expect(selectHarness("claude", null, false)).toBe("scripted")
    expect(selectHarness("codex", null, false)).toBe("scripted")
    // Discovery reports a too-old opencode (<1.18) as unavailable with a null
    // binPath, so the version gate lands here rather than failing mid-run.
    expect(selectHarness("opencode", null, false)).toBe("scripted")
  })

  it("forces scripted regardless of binary when forceScripted is set (tests/e2e)", () => {
    expect(selectHarness("claude", "/usr/bin/claude", true)).toBe("scripted")
    expect(selectHarness("codex", "/usr/bin/codex", true)).toBe("scripted")
    expect(selectHarness("opencode", "/opt/homebrew/bin/opencode", true)).toBe("scripted")
  })

  it("falls back to scripted for harnesses without a real adapter yet (Cursor)", () => {
    expect(selectHarness("cursor", "/usr/bin/cursor-agent", false)).toBe("scripted")
  })
})

/**
 * A resume id only means something to the harness that issued it: a Claude SDK
 * UUID handed to opencode is rejected outright by its `session.prompt`.
 *
 * `SessionStore.setHarness` already drops the PERSISTED id when a session
 * changes harness — but every adapter prefers the live in-memory map over the
 * spec (`resume.get(sessionId) ?? spec.resumeId`), so without this the cleared
 * persisted value never gets a look in and the stale id wins.
 */
describe("forgetForeignResume", () => {
  const run = (resume: Map<string, string>, minted: Map<string, CliKind>, cli: CliKind) =>
    forgetForeignResume(resume, minted, "s1", cli)

  it("keeps the id while the session stays on one harness", () => {
    const resume = new Map<string, string>()
    const minted = new Map<string, CliKind>()
    run(resume, minted, "claude")
    resume.set("s1", "claude-uuid")
    run(resume, minted, "claude")
    expect(resume.get("s1")).toBe("claude-uuid")
  })

  it("drops an id minted by another harness, so the new one starts fresh", () => {
    const resume = new Map<string, string>()
    const minted = new Map<string, CliKind>()
    run(resume, minted, "claude")
    resume.set("s1", "claude-uuid")

    // The operator switches to opencode from the model chip.
    run(resume, minted, "opencode")
    expect(resume.has("s1")).toBe(false)
  })

  /**
   * Switching BACK must not resurrect the old thread either: the store dropped
   * that resumeId on the first switch, so resuming it here would revive
   * something already discarded — and only until the next app restart, which is
   * a difference nobody could explain.
   */
  it("does not resurrect the original harness's id on switching back", () => {
    const resume = new Map<string, string>()
    const minted = new Map<string, CliKind>()
    run(resume, minted, "claude")
    resume.set("s1", "claude-uuid")
    run(resume, minted, "opencode")
    resume.set("s1", "ses_opencode")

    run(resume, minted, "claude")
    expect(resume.has("s1")).toBe(false)
  })

  it("leaves other sessions alone", () => {
    const resume = new Map<string, string>([["s2", "other-uuid"]])
    const minted = new Map<string, CliKind>([["s2", "codex"]])
    run(resume, minted, "claude")
    resume.set("s1", "claude-uuid")
    run(resume, minted, "opencode")
    expect(resume.get("s2")).toBe("other-uuid")
  })

  /** The pre-existing shape this PR inherits — same bug, same fix. */
  it("covers claude↔codex too, not just the new harness", () => {
    const resume = new Map<string, string>()
    const minted = new Map<string, CliKind>()
    run(resume, minted, "codex")
    resume.set("s1", "thread_codex")
    run(resume, minted, "claude")
    expect(resume.has("s1")).toBe(false)
  })
})
