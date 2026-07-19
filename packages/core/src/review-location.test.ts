import { describe, expect, it } from "vitest"
import type { ReviewFinding } from "./domain.js"
import { findingLocation } from "./review-location.js"

/**
 * This string is read across three surfaces that a user compares against each
 * other — the finding card, the PR review body, and the agent's prompt. The
 * behaviour worth pinning is therefore the FORMAT itself (it used to be
 * hand-rolled in each of the three), and the fact that an unanchored finding
 * says nothing rather than something wrong like `null:null`.
 */

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1",
  path: "src/a.ts",
  line: 12,
  endLine: null,
  severity: "nit",
  title: "t",
  rationale: "because",
  suggestion: null,
  resolvedBy: null,
  ...over
})

describe("findingLocation", () => {
  it("names a single line as path:line", () => {
    expect(findingLocation(finding({ line: 12, endLine: null }))).toBe("src/a.ts:12")
  })

  it("names a range with an en dash, not a hyphen", () => {
    // A hyphen reads as part of the filename; the en dash is the whole reason
    // this lives in one place rather than three.
    expect(findingLocation(finding({ line: 12, endLine: 14 }))).toBe("src/a.ts:12–14")
  })

  it("falls back to the bare path when the reviewer named no line", () => {
    expect(findingLocation(finding({ line: null, endLine: null }))).toBe("src/a.ts")
  })

  /**
   * A line without a path is meaningless, and the reviewer does emit it — the
   * caller must get null so it renders nothing at all.
   */
  it("is null when the finding is about the change as a whole", () => {
    expect(findingLocation(finding({ path: null, line: null }))).toBeNull()
    expect(findingLocation(finding({ path: null, line: 12 }))).toBeNull()
  })
})
