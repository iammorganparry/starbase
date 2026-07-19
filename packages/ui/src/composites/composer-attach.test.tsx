import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

/**
 * Attachments in Gigaplan.
 *
 * `Plan.adversarial` carries a brief and nothing else — its payload has no
 * images. So an attachment made in this mode cannot reach the round. The bug
 * worth guarding is not that images are unsupported; it is that they were
 * accepted, rendered into the transcript, and dropped in between, which reads to
 * the operator as "the planner saw my screenshot" when it never did.
 *
 * Refusing the gesture is the honest behaviour, and it must be visible: a
 * disabled control that says why beats one that silently swallows.
 */
afterEach(cleanup)

describe("Composer attachments in Gigaplan", () => {
  it("disables attaching, rather than accepting an image the round cannot carry", () => {
    render(<Composer mode="gigaplan" />)
    const attach = screen.getByTitle(/images aren't sent to a planning round/i)
    expect((attach as HTMLButtonElement).disabled).toBe(true)
  })

  it("says why, so the operator is not left guessing at a dead control", () => {
    render(<Composer mode="gigaplan" />)
    expect(screen.getByTitle(/Gigaplan plans from the written brief/i)).toBeTruthy()
  })

  it("leaves every other mode alone", () => {
    render(<Composer mode="accept-edits" />)
    const attach = screen.getByTitle("Attach an image")
    expect((attach as HTMLButtonElement).disabled).toBe(false)
  })
})
