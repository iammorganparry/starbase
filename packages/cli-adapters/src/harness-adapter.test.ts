import { describe, expect, it } from "vitest"
import { selectHarness } from "./harness-adapter.js"

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
