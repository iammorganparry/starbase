import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GridLayout } from "./layout-grid.js"
import { LayoutPicker, SessionGrid } from "./session-grid.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]

const renderGrid = (layout: GridLayout, onFocusSlot = vi.fn()) => {
  render(
    <SessionGrid
      layout={layout}
      sessions={sessions}
      onFocusSlot={onFocusSlot}
      renderConversation={(s) => <div>transcript {s.id}</div>}
    />
  )
  return onFocusSlot
}

describe("SessionGrid", () => {
  it("renders a pane per filled slot", () => {
    renderGrid({ mode: "1|1", slots: ["a", "b"], focused: 0 })
    expect(screen.getByText("transcript a")).toBeTruthy()
    expect(screen.getByText("transcript b")).toBeTruthy()
  })

  it("renders a drop placeholder for an empty slot, not an empty state", () => {
    // An empty SLOT is an invitation to drop; only an empty GRID is a dead end.
    renderGrid({ mode: "1|1", slots: ["a", null], focused: 0 })
    expect(screen.getByTestId("grid-slot-empty-1")).toBeTruthy()
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("lays out four slots in two columns for 2|2", () => {
    renderGrid({ mode: "2|2", slots: ["a", "b", "c", null], focused: 0 })
    expect(screen.getAllByTestId(/^grid-column-\d$/)).toHaveLength(2)
    expect(screen.getAllByTestId(/^grid-slot-\d$/)).toHaveLength(4)
  })

  it("renders 2|1 as a split left column beside a whole right column", () => {
    renderGrid({ mode: "2|1", slots: ["a", "b", "c"], focused: 0 })
    const columns = screen.getAllByTestId(/^grid-column-\d$/)
    expect(columns).toHaveLength(2)
    // Left column holds slots 0 and 1; the right column holds only slot 2.
    expect(within(columns[0]!).getAllByTestId(/^grid-slot-\d$/)).toHaveLength(2)
    expect(within(columns[1]!).getAllByTestId(/^grid-slot-\d$/)).toHaveLength(1)
    expect(within(columns[1]!).getByTestId("grid-slot-2")).toBeTruthy()
  })

  it("renders 1|2 as the mirror of 2|1 — the split is on the right", () => {
    renderGrid({ mode: "1|2", slots: ["a", "b", "c"], focused: 0 })
    const columns = screen.getAllByTestId(/^grid-column-\d$/)
    expect(within(columns[0]!).getAllByTestId(/^grid-slot-\d$/)).toHaveLength(1)
    expect(within(columns[0]!).getByTestId("grid-slot-0")).toBeTruthy()
    expect(within(columns[1]!).getAllByTestId(/^grid-slot-\d$/)).toHaveLength(2)
  })

  it("marks the focused slot, but not when there is only one pane", () => {
    renderGrid({ mode: "1|1", slots: ["a", "b"], focused: 1 })
    expect(screen.getByTestId("grid-slot-1").getAttribute("data-focused")).toBe("true")
    expect(screen.getByTestId("grid-slot-0").getAttribute("data-focused")).toBeNull()

    cleanup()
    renderGrid({ mode: "1", slots: ["a"], focused: 0 })
    // Still flagged for tests/styling hooks, but with nothing to disambiguate the
    // ring itself would be permanent chrome — so it must not be applied.
    expect(screen.getByTestId("grid-slot-0").className).not.toContain("ring-blue")
  })

  it("reports focus when a pane is clicked", () => {
    const onFocusSlot = renderGrid({ mode: "1|1", slots: ["a", "b"], focused: 0 })
    fireEvent.mouseDown(screen.getByTestId("grid-slot-1"))
    expect(onFocusSlot).toHaveBeenCalledWith(1)
  })

  it("skips a slot whose session no longer exists rather than crashing", () => {
    renderGrid({ mode: "1|1", slots: ["a", "deleted-id"], focused: 0 })
    expect(screen.getByTestId("grid-slot-empty-1")).toBeTruthy()
  })
})

describe("LayoutPicker", () => {
  it("marks the current mode and reports a change", () => {
    const onChange = vi.fn()
    render(<LayoutPicker mode="1|1" onChange={onChange} />)
    expect(screen.getByTestId("layout-mode-1|1").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByTestId("layout-mode-2|2"))
    expect(onChange).toHaveBeenCalledWith("2|2")
  })
})
