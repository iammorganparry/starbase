import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { testSession as session } from "../test-support.js"
import { SessionSidebar } from "./session-sidebar.js"

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const SESSIONS = [session({ id: "a", title: "Fix build" }), session({ id: "b", title: "Add auth" })]

const renderAt = (shellWidth: number, props: Partial<React.ComponentProps<typeof SessionSidebar>> = {}) =>
  render(
    <WidthTierValue width={shellWidth}>
      {/* Spread FIRST so the two required props can't be widened to `undefined`
          by an override that doesn't mention them. */}
      <SessionSidebar onSelect={() => {}} {...props} sessions={SESSIONS} activeSessionId="a" />
    </WidthTierValue>
  )

describe("SessionSidebar at shell width", () => {
  it("docks the full sidebar when the shell has room", () => {
    renderAt(1400)
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()
    expect(screen.queryByTestId("session-rail")).toBeNull()
  })

  it("collapses to the rail when the shell is cramped", () => {
    renderAt(820)
    expect(screen.getByTestId("session-rail")).toBeTruthy()
    expect(screen.queryByTestId("session-sidebar")).toBeNull()
  })

  it("keeps every session selectable by name from the rail", () => {
    // The title is the accessible name in rail mode too — the label is hidden,
    // the NAME is not.
    const onSelect = vi.fn()
    renderAt(820, { onSelect })
    fireEvent.click(screen.getByRole("button", { name: "Add auth" }))
    expect(onSelect).toHaveBeenCalledWith("b")
  })

  it("stays docked while the shell is unmeasured, so launch doesn't flash a rail", () => {
    renderAt(0)
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()
  })

  it("honours a pin over the width rule, and persists it", () => {
    renderAt(820)
    fireEvent.click(screen.getByLabelText("Pin sidebar open"))
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()

    cleanup()
    renderAt(820)
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()
  })

  it("opens the overlay only after hover INTENT, not on first contact", () => {
    vi.useFakeTimers()
    try {
      renderAt(820)
      fireEvent.mouseEnter(screen.getByTestId("session-rail"))
      // A pointer merely crossing the rail on its way elsewhere must not open it.
      expect(screen.queryByTestId("sidebar-overlay")).toBeNull()
      act(() => void vi.advanceTimersByTime(200))
      expect(screen.getByTestId("sidebar-overlay")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
