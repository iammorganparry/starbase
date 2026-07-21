import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_DND_MIME, type SplitGroup } from "./split-layout.js"
import { SessionSplit } from "./session-split.js"
import { testSession as session } from "../test-support.js"

afterEach(cleanup)

const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]

/** A group holding `ids`, split evenly, focused on pane `focused`. */
const groupOf = (ids: ReadonlyArray<string>, focused = 0): SplitGroup => ({
  id: "g1",
  panes: ids.map((sessionId) => ({ sessionId, ratio: 1 / ids.length })),
  focused
})

/**
 * jsdom has no real drag-and-drop, so the payload is modelled explicitly: a map
 * of MIME → value, exposing the same `types` / `getData` surface the handlers
 * actually use. `types` is the important half — the dragover path can only read
 * that one.
 */
const transfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (mime: string) => data[mime] ?? "",
  setData: vi.fn(),
  dropEffect: "",
  effectAllowed: ""
})

const sessionDrag = (id: string) => transfer({ [SESSION_DND_MIME]: id })

/**
 * A drop at a known position inside a pane.
 *
 * Two jsdom gaps to paper over. It reports every box as 0×0, so the pane's rect
 * is stubbed and the offset expressed against it. And its `DragEvent` drops the
 * `MouseEvent` half entirely — `fireEvent.drop(el, { clientX })` silently gives
 * the handler `undefined`, which reads as the middle zone whatever you passed.
 * So the coordinate is defined onto the event after construction.
 */
const dropAt = (index: number, fraction: number, sessionId: string) => {
  const pane = screen.getByTestId(`split-pane-${index}`)
  pane.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect
  const event = createEvent.drop(pane, { dataTransfer: sessionDrag(sessionId) })
  Object.defineProperty(event, "clientX", { value: fraction * 100 })
  Object.defineProperty(event, "clientY", { value: 50 })
  fireEvent(pane, event)
}

const renderSplit = (props: Partial<Parameters<typeof SessionSplit>[0]> = {}) =>
  render(
    <SessionSplit
      group={groupOf(["a", "b"])}
      sessions={sessions}
      renderConversation={(s) => <div>transcript {s.id}</div>}
      {...props}
    />
  )

describe("SessionSplit panes", () => {
  it("renders one pane per pane in the group, each showing its OWN session", () => {
    renderSplit()
    expect(within(screen.getByTestId("split-pane-0")).getByText("transcript a")).toBeTruthy()
    expect(within(screen.getByTestId("split-pane-1")).getByText("transcript b")).toBeTruthy()
  })

  it("renders the empty state when there is no group at all", () => {
    renderSplit({ group: null, emptyState: <span>nothing on screen</span> })
    expect(screen.getByText("nothing on screen")).toBeTruthy()
    expect(screen.queryByTestId("split-pane-0")).toBeNull()
  })

  it("skips a pane whose session has gone rather than throwing mid-prune", () => {
    // `prune` removes it on the next tick; this is the frame in between.
    renderSplit({ group: groupOf(["a", "gone"]) })
    expect(screen.queryByText("transcript gone")).toBeNull()
    expect(screen.getByText("transcript a")).toBeTruthy()
  })

  it("focuses a pane on mousedown anywhere inside it", () => {
    const onFocusPane = vi.fn()
    renderSplit({ onFocusPane })
    fireEvent.mouseDown(screen.getByText("transcript b"))
    expect(onFocusPane).toHaveBeenCalledWith(1)
  })
})

describe("pane controls", () => {
  it("offers no close control in a group of one — there is nothing to close back to", () => {
    renderSplit({ group: groupOf(["a"]), onClosePane: vi.fn() })
    expect(screen.queryByTestId("close-pane")).toBeNull()
  })

  it("closes the pane it was clicked in, by index", () => {
    const onClosePane = vi.fn()
    renderSplit({ onClosePane })
    fireEvent.click(within(screen.getByTestId("split-pane-1")).getByTestId("close-pane"))
    expect(onClosePane).toHaveBeenCalledWith(1)
  })

  it("hides Move Left at the left-hand end and Move Right at the right-hand end", () => {
    renderSplit({ onMovePane: vi.fn() })
    const first = screen.getByTestId("split-pane-0")
    const last = screen.getByTestId("split-pane-1")
    expect(within(first).queryByTestId("move-pane-left")).toBeNull()
    expect(within(first).getByTestId("move-pane-right")).toBeTruthy()
    expect(within(last).getByTestId("move-pane-left")).toBeTruthy()
    expect(within(last).queryByTestId("move-pane-right")).toBeNull()
  })

  it("moves a pane in the direction its control names", () => {
    const onMovePane = vi.fn()
    renderSplit({ group: groupOf(["a", "b", "c"]), onMovePane })
    fireEvent.click(within(screen.getByTestId("split-pane-1")).getByTestId("move-pane-left"))
    expect(onMovePane).toHaveBeenCalledWith(1, -1)
    fireEvent.click(within(screen.getByTestId("split-pane-1")).getByTestId("move-pane-right"))
    expect(onMovePane).toHaveBeenCalledWith(1, 1)
  })
})

describe("dropping a session onto a pane", () => {
  it("REPLACES the pane's session when dropped in the middle", () => {
    const onReplacePane = vi.fn()
    const onSplitWith = vi.fn()
    renderSplit({ onReplacePane, onSplitWith })
    dropAt(1, 0.5, "c")
    expect(onReplacePane).toHaveBeenCalledWith(1, "c")
    expect(onSplitWith).not.toHaveBeenCalled()
  })

  it("INSERTS a pane before the target when dropped on its left edge", () => {
    const onSplitWith = vi.fn()
    renderSplit({ onSplitWith, onReplacePane: vi.fn() })
    dropAt(1, 0.02, "c")
    expect(onSplitWith).toHaveBeenCalledWith("c", 1)
  })

  it("INSERTS a pane after the target when dropped on its right edge", () => {
    const onSplitWith = vi.fn()
    renderSplit({ onSplitWith, onReplacePane: vi.fn() })
    dropAt(1, 0.98, "c")
    expect(onSplitWith).toHaveBeenCalledWith("c", 2)
  })

  it("ignores a drag that is not one of our sessions", () => {
    // The composer accepts file drops; a pane must not swallow one.
    const onSplitWith = vi.fn()
    const onReplacePane = vi.fn()
    renderSplit({ onSplitWith, onReplacePane })
    fireEvent.drop(screen.getByTestId("split-pane-1"), {
      dataTransfer: transfer({ "text/plain": "hello" })
    })
    expect(onSplitWith).not.toHaveBeenCalled()
    expect(onReplacePane).not.toHaveBeenCalled()
  })
})

describe("dock mounting", () => {
  const docks = {
    renderTerminalDock: (s: { id: string }) => <div data-testid="terminal-dock">{s.id}</div>,
    renderBrowserDock: (s: { id: string } | null) => (
      <div data-testid="browser-dock">{s?.id ?? "none"}</div>
    ),
    onToggleBrowser: vi.fn(),
    browserActive: true
  }

  it("mounts each dock exactly once, however many panes are visible", () => {
    // The browser preview drives ONE native WebContentsView. Two mounts would
    // mean two rAF loops writing conflicting bounds to the same native view.
    renderSplit({ group: groupOf(["a", "b", "c"]), ...docks })
    expect(screen.getAllByTestId("browser-dock")).toHaveLength(1)
    expect(screen.getAllByTestId("terminal-dock")).toHaveLength(1)
  })

  it("mounts the docks OUTSIDE every pane, so a pane click cannot remount them", () => {
    // The regression this guards: the docks used to live inside the focused
    // pane, so clicking another pane unmounted the preview — and its unmount
    // cleanup calls browserPreviewClose(), destroying the view and losing the
    // page, its history and the URL.
    renderSplit(docks)
    for (const index of [0, 1]) {
      const pane = screen.getByTestId(`split-pane-${index}`)
      expect(within(pane).queryByTestId("browser-dock")).toBeNull()
      expect(within(pane).queryByTestId("terminal-dock")).toBeNull()
    }
  })

  it("keeps the same dock element across a focus change", () => {
    const { rerender } = renderSplit(docks)
    const before = screen.getByTestId("browser-dock")
    rerender(
      <SessionSplit
        group={groupOf(["a", "b"], 1)}
        sessions={sessions}
        renderConversation={(s) => <div>transcript {s.id}</div>}
        {...docks}
      />
    )
    expect(screen.getByTestId("browser-dock")).toBe(before)
  })

  it("points the terminal dock at the FOCUSED pane's session", () => {
    renderSplit({ group: groupOf(["a", "b"], 1), ...docks })
    expect(screen.getByTestId("terminal-dock").textContent).toBe("b")
  })

  it("falls back to the first pane when the focused index has no pane", () => {
    // Closing the focused pane can leave `focused` momentarily out of range;
    // the docks must not be stranded on nothing for that frame.
    renderSplit({ group: groupOf(["a"], 3), ...docks })
    expect(screen.getByTestId("terminal-dock").textContent).toBe("a")
  })
})
