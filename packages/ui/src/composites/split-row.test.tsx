import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Session } from "@starbase/core"
import { SplitRow } from "./split-row.js"
import { SESSION_DND_MIME, show, splitWith, type SplitGroup } from "../app/split-layout.js"

const session = (id: string, title: string): Session => ({
  id,
  title,
  repo: "starbase",
  branch: `starbase/${id}`,
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-21T10:00:00.000Z",
  archived: false
})

const SESSIONS = [session("a", "Refactor auth"), session("b", "Fix token refresh"), session("c", "Watch CI")]

afterEach(cleanup)

/**
 * jsdom has no real drag-and-drop, so the payload is modelled explicitly: a map
 * of MIME → value exposing the same `types` / `getData` surface the handlers
 * actually use. `types` is the important half — the dragover path can only read
 * that one. (Same shape as `session-split.test.tsx`.)
 */
const sessionDrag = (id: string) => ({
  types: [SESSION_DND_MIME],
  getData: (mime: string) => (mime === SESSION_DND_MIME ? id : ""),
  setData: vi.fn(),
  dropEffect: "",
  effectAllowed: ""
})

/** A two-pane group over sessions a and b, built through the real reducers. */
const twoPane = (): SplitGroup => {
  const seeded = show({ groups: [], activeGroupId: null }, "a")
  return splitWith(seeded, seeded.groups[0]!.id, "b", 1).groups[0]!
}

describe("SplitRow", () => {
  it("renders one segment per pane, each with its own close control", () => {
    render(<SplitRow group={twoPane()} sessions={SESSIONS} onClosePane={() => {}} />)
    expect(screen.getByTestId("split-segment-a")).toBeTruthy()
    expect(screen.getByTestId("split-segment-b")).toBeTruthy()
    // Arc: "hit the X next to either Split View Tab in the Sidebar to close it".
    expect(screen.getByTestId("split-close-a")).toBeTruthy()
    expect(screen.getByTestId("split-close-b")).toBeTruthy()
  })

  it("focuses the pane whose segment is clicked", async () => {
    const onFocusPane = vi.fn()
    const group = twoPane()
    render(<SplitRow group={group} sessions={SESSIONS} onFocusPane={onFocusPane} />)
    await userEvent.click(screen.getByTestId("split-segment-b"))
    expect(onFocusPane).toHaveBeenCalledWith(group.id, 1)
  })

  it("closes only the pane whose × was hit", async () => {
    const onClosePane = vi.fn()
    const group = twoPane()
    render(<SplitRow group={group} sessions={SESSIONS} onClosePane={onClosePane} />)
    await userEvent.click(screen.getByTestId("split-close-a"))
    expect(onClosePane).toHaveBeenCalledTimes(1)
    expect(onClosePane).toHaveBeenCalledWith(group.id, 0)
  })

  it("closing a segment does not also select it — the × is not the row", async () => {
    const onFocusPane = vi.fn()
    const onClosePane = vi.fn()
    render(
      <SplitRow group={twoPane()} sessions={SESSIONS} onFocusPane={onFocusPane} onClosePane={onClosePane} />
    )
    await userEvent.click(screen.getByTestId("split-close-b"))
    expect(onClosePane).toHaveBeenCalled()
    expect(onFocusPane).not.toHaveBeenCalled()
  })

  it("merges a dropped session in at the right-hand end", () => {
    const onSplitWith = vi.fn()
    const group = twoPane()
    render(<SplitRow group={group} sessions={SESSIONS} onSplitWith={onSplitWith} />)
    fireEvent.drop(screen.getByTestId(`split-row-${group.id}`), {
      dataTransfer: sessionDrag("c")
    })
    expect(onSplitWith).toHaveBeenCalledWith(group.id, "c", 2)
  })

  it("writes the session payload when a segment starts a drag", () => {
    // A segment is a drag SOURCE, not only a target: it is the only handle for
    // taking a session back OUT of a split, or moving it to another one. Without
    // this the split was a one-way door — and, worse, an e2e that dragged a
    // segment passed vacuously, because an empty `DataTransfer` is rejected by
    // the same guard that rejects a dragged file.
    const dataTransfer = sessionDrag("")
    render(<SplitRow group={twoPane()} sessions={SESSIONS} />)
    fireEvent.dragStart(screen.getByTestId("split-segment-b"), { dataTransfer })
    expect(dataTransfer.setData).toHaveBeenCalledWith(SESSION_DND_MIME, "b")
  })

  it("shows a peek card listing every session in the split, after a hover delay", async () => {
    const group = twoPane()
    render(<SplitRow group={group} sessions={SESSIONS} />)
    // Nothing on arrival — the card is a deliberate hover, not a flash.
    expect(screen.queryByTestId(`split-peek-${group.id}`)).toBeNull()
    await userEvent.hover(screen.getByTestId(`split-row-${group.id}`))
    const peek = await waitFor(() => screen.getByTestId(`split-peek-${group.id}`))
    expect(peek.textContent).toContain("Refactor auth")
    expect(peek.textContent).toContain("Fix token refresh")
  })

  it("separates the split from the peek card", async () => {
    const onSeparateAll = vi.fn()
    const group = twoPane()
    render(<SplitRow group={group} sessions={SESSIONS} onSeparateAll={onSeparateAll} />)
    await userEvent.hover(screen.getByTestId(`split-row-${group.id}`))
    const button = await waitFor(() => screen.getByTestId(`split-separate-${group.id}`))
    await userEvent.click(button)
    expect(onSeparateAll).toHaveBeenCalledWith(group.id)
  })

  it("marks the focused segment only while the group is the one on screen", () => {
    const group = twoPane()
    const { rerender } = render(
      <SplitRow group={group} sessions={SESSIONS} onClosePane={() => {}} active />
    )
    // Splitting focuses the pane it inserted, so "b" is the focused segment.
    expect(screen.getByTestId("split-close-b").className).toContain("opacity-100")
    rerender(<SplitRow group={group} sessions={SESSIONS} onClosePane={() => {}} active={false} />)
    expect(screen.getByTestId("split-close-b").className).toContain("opacity-0")
  })

  it("skips a pane whose session has vanished rather than rendering a blank segment", () => {
    render(<SplitRow group={twoPane()} sessions={[SESSIONS[0]!]} />)
    expect(screen.getByTestId("split-segment-a")).toBeTruthy()
    expect(screen.queryByTestId("split-segment-b")).toBeNull()
  })
})
