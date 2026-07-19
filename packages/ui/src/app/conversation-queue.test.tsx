import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConversationView } from "./conversation-view.js"

afterEach(cleanup)

/**
 * The queued-message list sits between the transcript and the composer, so its
 * height comes straight out of both. Routing an adversarial review's findings
 * queues one turn PER FINDING — twenty of them pushed the composer off the
 * bottom of the window entirely, which is the regression these pin.
 */

const queued = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `message ${i}`, images: [] }))

const rows = () => screen.queryAllByText(/^message \d+$/)

describe("ConversationView — queued messages", () => {
  it("shows every message while the queue is small", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(3)} />)
    expect(rows()).toHaveLength(3)
    expect(screen.queryByText(/more queued/)).toBeNull()
  })

  it("caps a long queue at five, and says how many are hidden", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(22)} />)
    expect(rows()).toHaveLength(5)
    expect(screen.getByText("+17 more queued")).toBeDefined()
  })

  it("expands to the full queue and back", () => {
    render(<ConversationView messages={[]} mode="accept-edits" queued={queued(22)} />)
    fireEvent.click(screen.getByText("+17 more queued"))
    expect(rows()).toHaveLength(22)
    fireEvent.click(screen.getByText("Show fewer"))
    expect(rows()).toHaveLength(5)
  })

  it("keeps each row's queue INDEX while capped", () => {
    // The cap is a `slice(0, n)`, so indices survive — but `onUnqueue` addresses
    // the queue positionally, and an off-by-one here would drop the wrong
    // message with no way for the operator to tell.
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getAllByTitle("Remove from queue")[2]!)
    expect(onUnqueue).toHaveBeenCalledWith(2)
  })

  it("addresses the right message once expanded past the cap", () => {
    const onUnqueue = vi.fn()
    render(
      <ConversationView messages={[]} mode="accept-edits" queued={queued(22)} onUnqueue={onUnqueue} />
    )
    fireEvent.click(screen.getByText("+17 more queued"))
    fireEvent.click(screen.getAllByTitle("Remove from queue")[20]!)
    expect(onUnqueue).toHaveBeenCalledWith(20)
  })
})
