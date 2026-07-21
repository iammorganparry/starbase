import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { LEGACY_LAYOUT_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from "./split-layout.js"
import { useSplitLayout } from "./use-split-layout.js"

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]

const paneIds = (result: { current: ReturnType<typeof useSplitLayout> }): ReadonlyArray<string> =>
  result.current.group?.panes.map((p) => p.sessionId) ?? []

beforeEach(() => localStorage.clear())

describe("useSplitLayout", () => {
  it("seeds the initial session on a first run", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "b"))
    expect(paneIds(result)).toEqual(["b"])
    expect(result.current.activeSessionId).toBe("b")
  })

  it("persists a split across a remount", () => {
    const { result, unmount } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "c", 1))
    unmount()

    const { result: reloaded } = renderHook(() => useSplitLayout(sessions, "a"))
    expect(paneIds(reloaded)).toEqual(["a", "c"])
  })

  it("treats a sidebar click on an off-screen session as 'show that one'", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    // The split stays intact in the sidebar; we're just looking elsewhere now.
    act(() => result.current.selectSession("c"))
    expect(paneIds(result)).toEqual(["c"])
    expect(result.current.workspace.groups).toHaveLength(2)
    expect(result.current.activeSessionId).toBe("c")
  })

  it("just focuses a session that is already on screen, rearranging nothing", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.selectSession("a"))
    expect(paneIds(result)).toEqual(["a", "b"])
    expect(result.current.activeSessionId).toBe("a")
  })

  it("reports every pane of the split as visible, not just the focused one", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    expect(result.current.visibleSessionIds).toEqual(new Set(["a", "b"]))
  })

  it("closes the focused pane without touching the others", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.splitInto(result.current.group!.id, "c", 2))
    // Splitting focuses the pane it just inserted, so this closes "c".
    act(() => result.current.closeFocused())
    expect(paneIds(result)).toEqual(["a", "b"])
  })

  it("moves the focused pane and keeps following it", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.moveFocused(-1))
    expect(paneIds(result)).toEqual(["b", "a"])
    expect(result.current.activeSessionId).toBe("b")
  })

  it("separates a split into one group per session", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.separateAll(result.current.group!.id))
    expect(result.current.workspace.groups).toHaveLength(2)
    expect(result.current.workspace.groups.every((g) => g.panes.length === 1)).toBe(true)
  })

  it("prunes panes whose session was deleted, even down to nothing", () => {
    const { result, rerender } = renderHook(
      ({ list }) => useSplitLayout(list, "a"),
      { initialProps: { list: sessions } }
    )
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    rerender({ list: [{ id: "b" }] })
    expect(paneIds(result)).toEqual(["b"])

    rerender({ list: [] })
    expect(result.current.workspace.groups).toHaveLength(0)
    expect(result.current.activeSessionId).toBeNull()
  })

  it("migrates a stored preset grid into one split on first boot", () => {
    localStorage.setItem(
      LEGACY_LAYOUT_STORAGE_KEY,
      JSON.stringify({ mode: "2|2", slots: ["a", null, "b", "c"], focused: 2 })
    )
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    expect(paneIds(result)).toEqual(["a", "b", "c"])
    expect(result.current.activeSessionId).toBe("b")
    // …and it is written back in the new shape, so the migration runs once.
    expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toContain("\"sessionId\":\"a\"")
  })

  it("survives a corrupt store rather than crashing the shell", () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, "{not json")
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    expect(paneIds(result)).toEqual(["a"])
  })

  it("maps each session to the group holding it, for the sidebar", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.selectSession("c"))
    const groupId = result.current.groupIdBySession.get("a")
    expect(result.current.groupIdBySession.get("b")).toBe(groupId)
    expect(result.current.groupIdBySession.get("c")).not.toBe(groupId)
  })
})
