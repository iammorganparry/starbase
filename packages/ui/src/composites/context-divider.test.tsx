import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ContextDigest } from "@starbase/core"
import { ContextDivider } from "./context-divider.js"

afterEach(cleanup)

const digest: ContextDigest = {
  goal: "Add rate limiting to the refund route",
  decisions: ["Reused the token bucket rather than adding a dependency"],
  filesTouched: ["src/routes/billing.ts"],
  openThreads: ["The 429 test is still failing"],
  preferences: ["Prefers Effect over raw async"],
  throughMessageId: "m2",
  builtAt: "2026-07-19T12:00:00.000Z"
}

/**
 * This component exists to answer one question — "does it still know about X?"
 * — without getting in the way of anyone who isn't asking it.
 */
describe("ContextDivider", () => {
  it("is collapsed by default, because this is reassurance rather than content", () => {
    render(<ContextDivider digest={digest} tokensBefore={290_000} />)
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(/Reused the token bucket/)).toBeNull()
  })

  it("names the working set it replaced, so the meter's drop is explicable", () => {
    render(<ContextDivider digest={digest} tokensBefore={290_000} />)
    expect(screen.getByText("Context compacted")).toBeDefined()
    expect(screen.getByText("from 290k")).toBeDefined()
  })

  it("shows everything carried forward once opened", () => {
    render(<ContextDivider digest={digest} tokensBefore={290_000} />)
    fireEvent.click(screen.getByRole("button"))

    expect(screen.getByText("Add rate limiting to the refund route")).toBeDefined()
    expect(screen.getByText("Reused the token bucket rather than adding a dependency")).toBeDefined()
    expect(screen.getByText("src/routes/billing.ts")).toBeDefined()
    expect(screen.getByText("The 429 test is still failing")).toBeDefined()
    expect(screen.getByText("Prefers Effect over raw async")).toBeDefined()
  })

  /**
   * The reassurance itself. A user looking at this is worried the app threw
   * their work away, and the copy has to answer that directly.
   */
  it("states outright that the history above is untouched", () => {
    render(<ContextDivider digest={digest} tokensBefore={290_000} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText(/full history above is unchanged/)).toBeDefined()
  })

  it("omits empty sections rather than showing bare headings", () => {
    render(
      <ContextDivider
        digest={{ ...digest, openThreads: [], preferences: [], filesTouched: [] }}
        tokensBefore={290_000}
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Open threads")).toBeNull()
    expect(screen.queryByText("Files touched")).toBeNull()
    expect(screen.getByText("Decisions")).toBeDefined()
  })

  it("omits the token line when the reading was never available", () => {
    render(<ContextDivider digest={digest} tokensBefore={0} />)
    expect(screen.queryByText(/^from /)).toBeNull()
    expect(screen.getByText("Context compacted")).toBeDefined()
  })

  it("toggles shut again", () => {
    render(<ContextDivider digest={digest} tokensBefore={290_000} />)
    const toggle = screen.getByRole("button")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })
})
