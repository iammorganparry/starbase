import { describe, expect, it } from "vitest"
import { adhdNote } from "./adhd-prompt.js"

/**
 * ADHD mode is a per-turn prompt prefix, so the only thing worth pinning is what
 * each harness is actually told. Claude is pointed at the operator's skill (the
 * source of truth they can edit without a release); every other harness cannot
 * see `~/.claude/skills`, so naming the skill there would be a silent no-op and
 * the rules have to travel inline.
 */
describe("adhdNote", () => {
  it("points Claude at the i-have-adhd skill", () => {
    const note = adhdNote("claude")
    expect(note).toContain("i-have-adhd:i-have-adhd")
  })

  it("carries the rules inline for Claude too, as a fallback", () => {
    expect(adhdNote("claude")).toContain("First line is an action")
  })

  it("never names a skill for harnesses that cannot see one", () => {
    for (const cli of ["codex", "cursor"] as const) {
      const note = adhdNote(cli)
      expect(note).not.toContain("i-have-adhd")
      expect(note).toContain("First line is an action")
      expect(note).toContain("End with ONE next action")
    }
  })
})
