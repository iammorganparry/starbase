import type { Session } from "@starbase/core"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionGrid } from "./session-grid.js"

afterEach(cleanup)

const session = (over: Partial<Session> & { id: string }): Session =>
  ({
    repo: "gtm-grid",
    branch: `starbase/${over.id}`,
    title: over.id,
    status: "idle",
    cli: "claude",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
    worktreePath: `/tmp/${over.id}`,
    baseBranch: "main",
    mode: "auto",
    ...over
  }) as Session

const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]

const renderGrid = (focused: number, slots: ReadonlyArray<string | null> = ["a", "b"]) =>
  render(
    <SessionGrid
      layout={{ mode: "1|1", slots, focused }}
      sessions={sessions}
      onFocusSlot={vi.fn()}
      renderConversation={(s) => <div>transcript {s.id}</div>}
      renderTerminalDock={(s) => <div data-testid={`terminal-dock-${s.id}`} />}
      renderBrowserDock={(s) => <div data-testid={`browser-dock-${s?.id}`} />}
      onToggleBrowser={vi.fn()}
      browserActive
    />
  )

describe("singleton dock ownership", () => {
  it("mounts the browser preview in exactly one pane, however many are visible", () => {
    // The preview is ONE native WebContentsView positioned from a placeholder's
    // bounding box. Two mounts would mean two rAF loops fighting over its bounds.
    renderGrid(0)
    expect(screen.getAllByTestId(/^browser-dock-/)).toHaveLength(1)
    expect(screen.getByTestId("browser-dock-a")).toBeTruthy()
  })

  it("mounts the terminal dock only in the focused pane", () => {
    renderGrid(1)
    expect(screen.queryByTestId("terminal-dock-a")).toBeNull()
    expect(screen.getByTestId("terminal-dock-b")).toBeTruthy()
  })

  it("moves the docks when focus moves", () => {
    const { unmount } = renderGrid(0)
    expect(screen.getByTestId("browser-dock-a")).toBeTruthy()
    unmount()

    renderGrid(1)
    expect(screen.getByTestId("browser-dock-b")).toBeTruthy()
    expect(screen.queryByTestId("browser-dock-a")).toBeNull()
  })

  it("greys out the browser toggle in unfocused panes and says who owns it", () => {
    // Hidden would read as a missing feature; inert-with-a-reason is honest.
    renderGrid(0)
    const paneB = screen.getByTestId("grid-slot-1")
    const toggle = within(paneB).getByTestId("toggle-browser") as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute("title")).toContain("pane 1")

    const paneA = screen.getByTestId("grid-slot-0")
    expect((within(paneA).getByTestId("toggle-browser") as HTMLButtonElement).disabled).toBe(false)
  })

  it("leaves the toggle live in a single-pane layout", () => {
    renderGrid(0, ["a"])
    const toggle = screen.getByTestId("toggle-browser") as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
  })
})

describe("when the focused slot is empty", () => {
  it("hands the docks to the first filled pane rather than unmounting them", () => {
    // You just closed the focused pane. `clear` leaves focus on the now-empty
    // slot, and an empty slot renders no SessionPane — so without a fallback
    // NOTHING would mount the terminal or browser dock.
    renderGrid(1, ["a", null])
    expect(screen.getByTestId("browser-dock-a")).toBeTruthy()
    expect(screen.getByTestId("terminal-dock-a")).toBeTruthy()
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
