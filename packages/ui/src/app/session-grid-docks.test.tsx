import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionGrid } from "./session-grid.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]

const renderGrid = (focused: number, slots: ReadonlyArray<string | null> = ["a", "b"]) =>
  render(
    <SessionGrid
      layout={{ mode: "1|1", slots, focused }}
      sessions={sessions}
      onFocusSlot={vi.fn()}
      renderConversation={(s) => <div>transcript {s.id}</div>}
      renderTerminalDock={(s) => <div data-testid="terminal-dock">{s.id}</div>}
      renderBrowserDock={(s) => <div data-testid="browser-dock">{s?.id ?? "none"}</div>}
      onToggleBrowser={vi.fn()}
      browserActive
    />
  )

describe("dock mounting", () => {
  it("mounts each dock exactly once, however many panes are visible", () => {
    // The browser preview drives ONE native WebContentsView. Two mounts would
    // mean two rAF loops writing conflicting bounds to the same native view.
    renderGrid(0)
    expect(screen.getAllByTestId("browser-dock")).toHaveLength(1)
    expect(screen.getAllByTestId("terminal-dock")).toHaveLength(1)
  })

  it("mounts the docks OUTSIDE every pane, so a pane click cannot remount them", () => {
    // The regression this guards: the docks used to live inside the focused
    // pane, so clicking another pane unmounted the preview — and its unmount
    // cleanup calls browserPreviewClose(), destroying the view and losing the
    // page, its history and the URL. Clicking a pane must not touch them.
    renderGrid(0)
    for (const slot of [0, 1]) {
      const pane = screen.getByTestId(`grid-slot-${slot}`)
      expect(within(pane).queryByTestId("browser-dock")).toBeNull()
      expect(within(pane).queryByTestId("terminal-dock")).toBeNull()
    }
  })

  it("keeps the same dock element across a focus change", () => {
    const { rerender } = renderGrid(0)
    const before = screen.getByTestId("browser-dock")

    rerender(
      <SessionGrid
        layout={{ mode: "1|1", slots: ["a", "b"], focused: 1 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        renderTerminalDock={(s) => <div data-testid="terminal-dock">{s.id}</div>}
        renderBrowserDock={(s) => <div data-testid="browser-dock">{s?.id ?? "none"}</div>}
        onToggleBrowser={vi.fn()}
        browserActive
      />
    )
    // Same DOM node, not a replacement — React reconciled rather than remounted,
    // which is what stops the native view being torn down and reopened.
    expect(screen.getByTestId("browser-dock")).toBe(before)
  })

  it("points the per-session terminal dock at the focused session", () => {
    renderGrid(1)
    expect(screen.getByTestId("terminal-dock").textContent).toBe("b")
  })

  it("falls back to the first filled slot when the focused slot is empty", () => {
    // You just closed the focused pane; `clear` leaves focus on the empty slot.
    renderGrid(1, ["a", null])
    expect(screen.getByTestId("terminal-dock").textContent).toBe("a")
  })

  it("leaves the browser toggle live in every pane", () => {
    // The dock is app-level now, so every pane's toggle drives the same one —
    // there is no longer an "owning" pane whose toggle alone works.
    renderGrid(0)
    for (const slot of [0, 1]) {
      const pane = screen.getByTestId(`grid-slot-${slot}`)
      const toggle = within(pane).getByTestId("toggle-browser") as HTMLButtonElement
      expect(toggle.disabled).toBe(false)
    }
  })
})

describe("closing a pane", () => {
  const renderClosable = (slots: ReadonlyArray<string | null>, onClearSlot = vi.fn()) => {
    render(
      <SessionGrid
        layout={{ mode: slots.length === 1 ? "1" : "1|1", slots, focused: 0 }}
        sessions={sessions}
        onFocusSlot={vi.fn()}
        onClearSlot={onClearSlot}
        renderConversation={(s) => <div>transcript {s.id}</div>}
      />
    )
    return onClearSlot
  }

  it("empties the slot it was clicked in", () => {
    const onClearSlot = renderClosable(["a", "b"])
    const paneB = screen.getByTestId("grid-slot-1")
    fireEvent.click(within(paneB).getByTestId("close-pane"))
    expect(onClearSlot).toHaveBeenCalledWith(1)
  })

  it("offers no close control in a single-pane layout", () => {
    // With one slot there is nothing to close back TO — the control would only be
    // a way to blank the app.
    renderClosable(["a"])
    expect(screen.queryByTestId("close-pane")).toBeNull()
  })
})
