import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

/**
 * Attachments in Gigaplan.
 *
 * These used to be REFUSED, because `Plan.adversarial` carried a brief and
 * nothing else: an image accepted here would render into the transcript and be
 * dropped on the way to the round, which reads to the operator as "the planner
 * saw my screenshot" when it never did.
 *
 * The payload now carries `images` and hands them to every role's `SessionSpec`,
 * so the honest behaviour flipped: accepting is correct, and a briefing that is
 * half screenshot is exactly the case Gigaplan is for. These tests hold the new
 * contract, and specifically that the control is not special-cased by mode —
 * the old guard lived in three places (button, `addFiles`, the "+" tile) and any
 * one left behind silently loses the attachment.
 */
afterEach(cleanup)

describe("Composer attachments in Gigaplan", () => {
  it("allows attaching — the round carries images now", () => {
    render(<Composer mode="gigaplan" />)
    const attach = screen.getByLabelText("Attach an image")
    expect((attach as HTMLButtonElement).disabled).toBe(false)
  })

  it("keeps one stable accessible name, so it can't answer to another control's", () => {
    // Regression: the explanation used to BE the name, which made this button
    // match a by-name lookup for the Gigaplan mode chip.
    render(<Composer mode="gigaplan" />)
    expect(screen.getByLabelText("Attach an image")).toBeTruthy()
  })

  it("says the same thing it says everywhere else — no mode-specific excuse", () => {
    render(<Composer mode="gigaplan" />)
    expect(screen.getByTitle("Attach an image")).toBeTruthy()
    expect(screen.queryByTitle(/images aren't sent/i)).toBe(null)
  })

  it("leaves every other mode alone", () => {
    render(<Composer mode="accept-edits" />)
    const attach = screen.getByTitle("Attach an image")
    expect((attach as HTMLButtonElement).disabled).toBe(false)
  })

  it("labels Codex ask mode by its safe read-only behaviour", () => {
    render(<Composer cli="codex" mode="ask" />)
    expect(screen.getByText("read only")).toBeTruthy()
    expect(screen.queryByText("ask")).toBe(null)
  })
})
