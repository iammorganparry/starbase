import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { prGlyphOf, PrStatusGlyph } from "./pr-glyph.js"

afterEach(cleanup)

describe("prGlyphOf", () => {
  it("gives a session with no PR a placeholder, not a status colour", () => {
    // A blank slot would let the rows below it shift left and the list would
    // stop scanning as a column. Grey says "nothing here", not "something bad".
    const none = prGlyphOf(null)
    expect(none.tone).toBe("text-line-strong")
    expect(none.mark).toBeNull()
    expect(none.label).toBe("No pull request")
  })

  it("colours an open PR by its CI, not by the fact it is open", () => {
    expect(prGlyphOf({ state: "open", checks: "pass" }).tone).toBe("text-green")
    expect(prGlyphOf({ state: "open", checks: "fail" }).tone).toBe("text-red")
    expect(prGlyphOf({ state: "open", checks: "running" }).tone).toBe("text-yellow")
  })

  it("marks only the two states worth interrupting for", () => {
    expect(prGlyphOf({ state: "open", checks: "fail" }).mark).toBe("fail")
    expect(prGlyphOf({ state: "open", checks: "pass" }).mark).toBe("pass")
    // "Still going" is not something to act on yet, so it gets colour but no mark.
    expect(prGlyphOf({ state: "open", checks: "running" }).mark).toBeNull()
    expect(prGlyphOf({ state: "open", checks: "pending" }).mark).toBeNull()
  })

  it("does not claim a passing build when no build ran", () => {
    // Null checks means the repo has no CI on this PR. Green would be a lie.
    const glyph = prGlyphOf({ state: "open", checks: null })
    expect(glyph.tone).toBe("text-purple")
    expect(glyph.mark).toBeNull()
  })

  it("keeps draft and open visually distinct at the same CI status", () => {
    const draft = prGlyphOf({ state: "draft", checks: "pass" })
    const open = prGlyphOf({ state: "open", checks: "pass" })
    // Same colour — CI is CI. Different SHAPE, because that's the other channel.
    expect(draft.tone).toBe(open.tone)
    expect(draft.Icon).not.toBe(open.Icon)
    expect(draft.label).toContain("Draft")
  })

  it("reports merged and closed by shape, ignoring any stale CI", () => {
    const merged = prGlyphOf({ state: "merged", checks: "fail" })
    expect(merged.tone).toBe("text-purple")
    expect(merged.mark).toBeNull()
    expect(prGlyphOf({ state: "closed", checks: null }).label).toBe("Pull request closed")
  })

  it("always produces a label, because a 14px glyph cannot say anything itself", () => {
    const cases = [
      null,
      { state: "open", checks: "fail" },
      { state: "draft", checks: null },
      { state: "merged", checks: null }
    ] as const
    for (const pr of cases) expect(prGlyphOf(pr).label.length).toBeGreaterThan(0)
  })
})

describe("PrStatusGlyph", () => {
  it("exposes its meaning to hover AND to a screen reader", () => {
    render(<PrStatusGlyph pr={{ state: "open", checks: "fail" }} />)
    // `title` for the pointer, `sr-only` text for assistive tech — a bare icon
    // would read as "graphic".
    expect(screen.getByTitle("Pull request open — checks failing")).toBeDefined()
    expect(screen.getByText("Pull request open — checks failing")).toBeDefined()
  })

  it("publishes its state as data attributes, so the e2e suite can assert on it", () => {
    render(<PrStatusGlyph pr={{ state: "draft", checks: "running" }} />)
    const glyph = screen.getByTestId("pr-glyph")
    expect(glyph.dataset.state).toBe("draft")
    expect(glyph.dataset.checks).toBe("running")
  })

  it("renders for a session with no PR rather than collapsing the slot", () => {
    render(<PrStatusGlyph pr={null} />)
    expect(screen.getByTestId("pr-glyph").dataset.state).toBe("none")
  })
})
