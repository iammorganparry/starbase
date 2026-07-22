import { CliExecError } from "@starbase/core"
import { describe, expect, it } from "vitest"
import { classifyProviderFailure, toolMayMutate } from "./provider-failure.js"

describe("classifyProviderFailure", () => {
  it.each([
    "429 rate limit exceeded",
    "provider overloaded",
    "ECONNRESET",
    "model is not deployed",
    "service temporarily unavailable",
    "The attempt timed out after 30 minutes without finishing."
  ])("classifies %s as reroutable provider infrastructure", (message) => {
    expect(classifyProviderFailure(message).classification).toBe("transient-provider")
  })

  it.each([
    "authentication failed; run login",
    "missing API key",
    "permission denied",
    "invalid plan",
    "requires user decision"
  ])("classifies %s as operator action", (message) => {
    expect(classifyProviderFailure(message).classification).toBe("terminal-operator")
  })

  it("preserves typed CLI error details", () => {
    expect(
      classifyProviderFailure(new CliExecError({ kind: "codex", message: "provider unavailable" }))
    ).toStrictEqual({
      classification: "transient-provider",
      message: "provider unavailable",
      kind: "codex"
    })
  })

  it("keeps unknown failures terminal", () => {
    expect(classifyProviderFailure("unexpected protocol frame").classification).toBe(
      "terminal-execution"
    )
  })
})

describe("toolMayMutate", () => {
  it.each(["Read", "Grep", "Glob", "WebSearch"])("recognizes %s as read-only", (tool) => {
    expect(toolMayMutate(tool)).toBe(false)
  })

  it.each(["Edit", "Write", "Bash", "ApplyPatch", "unknown-tool"])(
    "treats %s as mutation-capable",
    (tool) => {
      expect(toolMayMutate(tool)).toBe(true)
    }
  )
})
