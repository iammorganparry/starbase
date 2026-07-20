import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { LAYOUT_STORAGE_KEY, load } from "./layout-grid.js"
import { useGridLayout } from "./use-grid-layout.js"

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }]

beforeEach(() => localStorage.clear())

describe("useGridLayout", () => {
  it("seeds slot 0 with the initial session on a first run", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "b"))
    expect(result.current.layout.slots).toEqual(["b"])
    expect(result.current.activeSessionId).toBe("b")
  })

  it("persists across a remount", () => {
    const { result, unmount } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("2|2"))
    act(() => result.current.assignToSlot(2, "c"))
    unmount()

    const { result: reloaded } = renderHook(() => useGridLayout(sessions, "a"))
    expect(reloaded.current.layout.mode).toBe("2|2")
    expect(reloaded.current.layout.slots).toEqual(["a", null, "c", null])
  })

  it("treats a sidebar click on an OFF-grid session as 'show it in this pane'", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|1"))
    act(() => result.current.assignToSlot(1, "b"))
    // Focus is now slot 1 (assigning focuses). Clicking session c must replace
    // what's in THAT pane, not slot 0 — which is the old single-select behaviour
    // generalised to a grid.
    act(() => result.current.selectSession("c"))
    expect(result.current.layout.slots).toEqual(["a", "c"])
    expect(result.current.activeSessionId).toBe("c")
  })

  it("just focuses a session that is already on the grid, rearranging nothing", () => {
    // Falling through to `assign` would apply its SWAP semantics and yank the
    // session out of the pane the operator can see it in, pushing the focused
    // pane's session into the hole — two panes move when they wanted to read one.
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|1"))
    act(() => result.current.assignToSlot(1, "b"))
    expect(result.current.layout.focused).toBe(1)

    act(() => result.current.selectSession("a"))
    expect(result.current.layout.slots).toEqual(["a", "b"])
    expect(result.current.layout.focused).toBe(0)
    expect(result.current.activeSessionId).toBe("a")
  })

  it("drops slots whose session no longer exists", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["a", "deleted"], focused: 0 })
    )
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    expect(result.current.layout.slots).toEqual(["a", null])
  })

  it("clears every slot when the last session is deleted", () => {
    // `StarbaseApp` only mounts once the app machine leaves loading, so an empty
    // list means everything really was deleted. Treating it as "still loading"
    // left the grid holding dead ids and showed drop placeholders with nothing
    // left to drag, instead of the first-launch screen — and persisted that.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["a", "b"], focused: 0 })
    )
    const { result } = renderHook(() => useGridLayout([], null))
    expect(result.current.layout.slots).toEqual([null, null])
    expect(result.current.visibleSessionIds.size).toBe(0)
  })

  it("exposes the slot each session sits in, for the sidebar badges", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("2|2"))
    act(() => result.current.assignToSlot(3, "c"))
    expect(result.current.slotBySession.get("a")).toBe(0)
    expect(result.current.slotBySession.get("c")).toBe(3)
    expect(result.current.slotBySession.has("b")).toBe(false)
  })

  it("drops a deleted session from the grid via the prune pass", () => {
    const { result, rerender } = renderHook(({ list }) => useGridLayout(list, "a"), {
      initialProps: { list: sessions as ReadonlyArray<{ id: string }> }
    })
    act(() => result.current.changeMode("1|1"))
    act(() => result.current.assignToSlot(1, "b"))
    // Session a is deleted upstream — the grid must not keep pointing at it.
    rerender({ list: [{ id: "b" }, { id: "c" }] })
    expect(result.current.layout.slots).toEqual([null, "b"])
  })

  it("reports EVERY on-screen session, not just the focused one", () => {
    // Notification suppression reads this. The main process's rule is "don't tell
    // them what they can already see" — so a session sitting visible in an
    // unfocused pane must count as seen, or it raises an OS toast for something
    // the operator is looking straight at.
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("2|1"))
    act(() => result.current.assignToSlot(1, "b"))
    act(() => result.current.focusSlot(0))

    expect(result.current.activeSessionId).toBe("a")
    expect([...result.current.visibleSessionIds].sort()).toEqual(["a", "b"])
  })

  it("drops a session from the visible set once its slot is cleared", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|1"))
    act(() => result.current.assignToSlot(1, "b"))
    act(() => result.current.clearSlot(1))
    expect([...result.current.visibleSessionIds]).toEqual(["a"])
  })

  it("writes every change straight through to storage", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|2"))
    expect(load().mode).toBe("1|2")
  })
})
