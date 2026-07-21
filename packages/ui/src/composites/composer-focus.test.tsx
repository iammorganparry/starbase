import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Composer } from "./composer.js"

/**
 * Opening a conversation should leave the caret where you type at the agent.
 * The focus is deferred a frame (the transcript scrolls to the bottom on its
 * first layout pass and would otherwise steal it back), so these wait rather
 * than assert synchronously.
 */

afterEach(cleanup)

describe("Composer autofocus", () => {
  it("takes the caret when it is the pane on screen", async () => {
    render(<Composer autoFocus focusKey="s1" />)
    const textarea = screen.getByRole("textbox")
    await waitFor(() => expect(document.activeElement).toBe(textarea))
  })

  it("leaves the caret alone when another pane is the focused one", async () => {
    render(<Composer autoFocus={false} focusKey="s1" />)
    const textarea = screen.getByRole("textbox")
    // Give the deferred focus a chance to happen, then assert it did not.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).not.toBe(textarea)
  })

  it("refocuses when the pane swaps to a different session", async () => {
    const { rerender } = render(<Composer autoFocus focusKey="s1" />)
    const textarea = screen.getByRole("textbox")
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    ;(document.activeElement as HTMLElement).blur()
    rerender(<Composer autoFocus focusKey="s2" />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")))
  })
})
