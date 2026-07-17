import { describe, expect, it } from "vitest"
import { claudeDefaultMode, codexDefaultMode, opencodeDefaultMode } from "./default-mode.js"

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

describe("opencodeDefaultMode", () => {
  const cfg = (permission: unknown) => JSON.stringify({ permission })

  it("maps opencode's permission block onto our exec modes", () => {
    expect(opencodeDefaultMode(cfg("allow"))).toBe("auto")
    expect(opencodeDefaultMode(cfg({ edit: "allow", bash: "allow" }))).toBe("auto")
    expect(opencodeDefaultMode(cfg({ edit: "allow", bash: "ask" }))).toBe("accept-edits")
    expect(opencodeDefaultMode(cfg({ edit: "ask", bash: "ask" }))).toBe("ask")
    expect(opencodeDefaultMode(cfg("ask"))).toBe("ask")
  })

  it("honours a `*` default for tools that aren't named", () => {
    expect(opencodeDefaultMode(cfg({ "*": "allow" }))).toBe("auto")
    // The explicit key wins over the wildcard.
    expect(opencodeDefaultMode(cfg({ "*": "allow", edit: "ask" }))).toBe("ask")
  })

  /**
   * A glob ruleset means the user wants to be asked about *most* of a tool's
   * uses. Reading `{ "*": "ask", "git *": "allow" }` as a blanket grant would
   * invert their intent and hand the agent an unattended shell.
   */
  it("does not mistake a glob ruleset for a blanket grant", () => {
    expect(opencodeDefaultMode(cfg({ edit: "allow", bash: { "*": "ask", "git *": "allow" } }))).toBe(
      "accept-edits"
    )
    expect(opencodeDefaultMode(cfg({ bash: { "*": "allow" } }))).toBe("accept-edits")
  })

  it("maps deny onto ask — there is no refuse-everything exec mode", () => {
    expect(opencodeDefaultMode(cfg({ edit: "deny" }))).toBe("ask")
    expect(opencodeDefaultMode(cfg("deny"))).toBe("ask")
  })

  it("falls back to accept-edits on missing config / no permission block / bad JSON", () => {
    expect(opencodeDefaultMode("")).toBe("accept-edits")
    expect(opencodeDefaultMode("{ not json")).toBe("accept-edits")
    expect(opencodeDefaultMode(JSON.stringify({ model: "opencode/big-pickle" }))).toBe("accept-edits")
    // opencode allows comments; JSON.parse doesn't. Falling back beats guessing.
    expect(opencodeDefaultMode('{ // hi\n "permission": "allow" }')).toBe("accept-edits")
  })
})
