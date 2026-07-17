import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

/**
 * While the agent works, the primary button halts it. Queueing isn't lost — it
 * moves to the keyboard (↵), which is what the placeholder advertises. These
 * cover exactly that swap, since getting it wrong either strands the operator
 * with no way to stop, or silently removes their ability to queue.
 */

afterEach(cleanup)

describe("Composer stop button", () => {
  it("offers Send when the agent is idle", () => {
    render(<Composer busy={false} onStop={() => {}} />)
    expect(screen.getByRole("button", { name: /Send/ })).toBeDefined()
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull()
  })

  it("swaps Send for Stop while the agent is busy", () => {
    render(<Composer busy onStop={() => {}} />)
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeDefined()
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull()
  })

  it("halts the agent when Stop is clicked", () => {
    const onStop = vi.fn()
    render(<Composer busy onStop={onStop} />)
    fireEvent.click(screen.getByRole("button", { name: /^Stop$/ }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it("still queues a follow-up on Enter while busy", () => {
    const onSend = vi.fn()
    render(<Composer busy onSend={onSend} onStop={() => {}} />)
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "do this next" } })
    fireEvent.keyDown(box, { key: "Enter" })
    // The Stop button must not cost the operator their queue.
    expect(onSend).toHaveBeenCalledWith("do this next", [])
  })

  it("keeps the Queue button when no stop handler is wired", () => {
    // Consumers that can't stop (stories, read-only screens) keep the old shape
    // rather than rendering a dead button.
    render(<Composer busy />)
    expect(screen.getByRole("button", { name: /Queue/ })).toBeDefined()
  })

  it("shows neither while paused for approval", () => {
    render(<Composer busy paused onStop={() => {}} />)
    expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull()
    expect(screen.getByText(/paused for approval/)).toBeDefined()
  })
})
