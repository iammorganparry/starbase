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

  it("treats a sidebar click as 'show this in the pane I'm looking at'", () => {
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

  it("drops slots whose session no longer exists", () => {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["a", "deleted"], focused: 0 })
    )
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    expect(result.current.layout.slots).toEqual(["a", null])
  })

  it("does not blank the grid while the session list is still loading", () => {
    // An empty `sessions` array is the loading state, not "everything was
    // deleted" — pruning against it would wipe the restored layout on every boot.
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "1|1", slots: ["a", "b"], focused: 0 })
    )
    const { result } = renderHook(() => useGridLayout([], null))
    expect(result.current.layout.slots).toEqual(["a", "b"])
  })

  it("exposes the slot each session sits in, for the sidebar badges", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("2|2"))
    act(() => result.current.assignToSlot(3, "c"))
    expect(result.current.slotBySession.get("a")).toBe(0)
    expect(result.current.slotBySession.get("c")).toBe(3)
    expect(result.current.slotBySession.has("b")).toBe(false)
  })

  it("removes a session from the grid when it is deleted", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|1"))
    act(() => result.current.assignToSlot(1, "b"))
    act(() => result.current.removeSession("a"))
    expect(result.current.layout.slots).toEqual([null, "b"])
  })

  it("writes every change straight through to storage", () => {
    const { result } = renderHook(() => useGridLayout(sessions, "a"))
    act(() => result.current.changeMode("1|2"))
    expect(load().mode).toBe("1|2")
  })
})
