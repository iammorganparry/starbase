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

  it("falls back to scripted when the binary is missing", () => {
    expect(selectHarness("claude", null, false)).toBe("scripted")
  })

  it("forces scripted regardless of binary when forceScripted is set (tests/e2e)", () => {
    expect(selectHarness("claude", "/usr/bin/claude", true)).toBe("scripted")
  })

  it("falls back to scripted for harnesses without a real adapter yet", () => {
    expect(selectHarness("codex", "/usr/bin/codex", false)).toBe("scripted")
    expect(selectHarness("cursor", "/usr/bin/cursor-agent", false)).toBe("scripted")
  })
})
