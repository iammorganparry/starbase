import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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
    fireEvent.click(screen.getByLabelText("Expand sidebar"))
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()

    cleanup()
    renderAt(820)
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()
  })

  it("shows one session's details on hover — not the whole sidebar back again", async () => {
    renderAt(820)
    // Radix opens on FOCUS as well as on hover, which is both the keyboard story
    // and the only one jsdom can drive — it has no real pointer to rest.
    fireEvent.focus(screen.getByRole("button", { name: "Add auth" }))

    const card = await screen.findByTestId("hover-card")
    expect(card.textContent).toContain("Add auth")
    // The card is the detail view now. Re-floating the entire sidebar on hover
    // meant one gesture did two things, the second covering the first.
    expect(screen.queryByTestId("sidebar-overlay")).toBeNull()
    expect(screen.queryByTestId("session-sidebar")).toBeNull()
  })

  it("expands from the rail's button, and collapses again from the header's", () => {
    renderAt(820)
    fireEvent.click(screen.getByLabelText("Expand sidebar"))
    expect(screen.getByTestId("session-sidebar")).toBeTruthy()

    fireEvent.click(screen.getByLabelText("Collapse sidebar"))
    expect(screen.getByTestId("session-rail")).toBeTruthy()
  })

  it("collapses a roomy shell from the header button, and remembers it", () => {
    renderAt(1400)
    fireEvent.click(screen.getByLabelText("Collapse sidebar"))
    expect(screen.getByTestId("session-rail")).toBeTruthy()

    // The pin outranks the width rule in BOTH directions — a collapse that the
    // next mount silently undoes is a control that lies about its state.
    cleanup()
    renderAt(1400)
    expect(screen.getByTestId("session-rail")).toBeTruthy()
  })
})
