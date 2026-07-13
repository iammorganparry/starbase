import { describe, expect, it } from "vitest"
import { claudeDefaultMode, codexDefaultMode } from "./default-mode.js"

/**
 * The config → exec-mode mapping is the seam that lets "approve plan" drop the
 * user back into the mode they normally run in. Pure, so we test it directly;
 * the filesystem read (`readDefaultMode`) is a thin wrapper verified live.
 */

describe("claudeDefaultMode", () => {
  it("maps Claude Code's permissions.defaultMode onto our exec modes", () => {
    expect(claudeDefaultMode(JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }))).toBe("auto")
    expect(claudeDefaultMode(JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }))).toBe("accept-edits")
    expect(claudeDefaultMode(JSON.stringify({ permissions: { defaultMode: "default" } }))).toBe("ask")
  })

  it("never restores into plan; treats 'plan' and unknown values as the exec fallback", () => {
    expect(claudeDefaultMode(JSON.stringify({ permissions: { defaultMode: "plan" } }))).toBe("accept-edits")
    expect(claudeDefaultMode(JSON.stringify({ permissions: { defaultMode: "wat" } }))).toBe("accept-edits")
  })

  it("falls back to accept-edits on missing config / bad JSON", () => {
    expect(claudeDefaultMode("")).toBe("accept-edits")
    expect(claudeDefaultMode("{ not json")).toBe("accept-edits")
    expect(claudeDefaultMode(JSON.stringify({}))).toBe("accept-edits")
  })
})

describe("codexDefaultMode", () => {
  it("maps Codex approval_policy / sandbox_mode onto our exec modes", () => {
    expect(codexDefaultMode('approval_policy = "never"')).toBe("auto")
    expect(codexDefaultMode('sandbox_mode = "danger-full-access"')).toBe("auto")
    expect(codexDefaultMode('approval_policy = "on-failure"')).toBe("accept-edits")
    expect(codexDefaultMode('sandbox_mode = "workspace-write"')).toBe("accept-edits")
    expect(codexDefaultMode('approval_policy = "on-request"')).toBe("ask")
    expect(codexDefaultMode('sandbox_mode = "read-only"')).toBe("ask")
  })

  it("falls back to accept-edits when neither key is present", () => {
    expect(codexDefaultMode("")).toBe("accept-edits")
    expect(codexDefaultMode("model = \"gpt-5\"")).toBe("accept-edits")
  })
})
