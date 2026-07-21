import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LEGACY_LAYOUT_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from "./split-layout.js"
import { useSplitLayout } from "./use-split-layout.js"

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]

const paneIds = (result: { current: ReturnType<typeof useSplitLayout> }): ReadonlyArray<string> =>
  result.current.group?.panes.map((p) => p.sessionId) ?? []

beforeEach(() => localStorage.clear())
// Fake timers are opt-in per test below; make sure one never leaks into the next.
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

  it("replaces the LEFTMOST pane in one update — the id shifts under a two-step swap", () => {
    const { result } = renderHook(() => useSplitLayout(sessions, "a"))
    act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    act(() => result.current.replacePane(result.current.group!.id, 0, "c"))
    expect(paneIds(result)).toEqual(["c", "b"])
    expect(result.current.activeSessionId).toBe("c")
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

  /**
   * Archiving is how a session is retired, so it gives up its pane.
   *
   * Beyond the model argument there was a concrete defect: an archived session
   * that kept its pane was drawn twice in the sidebar — as a segment of its
   * split's pill and as a row under Archived — and both carry the same `motion`
   * `layoutId`. Two mounted elements sharing one is undefined behaviour; the
   * shared-element tween can snap either to the other's box.
   */
  describe("archiving", () => {
    const archiving = (archivedIds: ReadonlyArray<string>) =>
      sessions.map((s) => ({ ...s, archived: archivedIds.includes(s.id) }))

    it("drops an archived session's pane and closes the gap", () => {
      const { result, rerender } = renderHook(({ list }) => useSplitLayout(list, "a"), {
        initialProps: { list: sessions as ReadonlyArray<{ id: string; archived?: boolean }> }
      })
      act(() => result.current.splitInto(result.current.group!.id, "b", 1))
      act(() => result.current.splitInto(result.current.group!.id, "c", 2))
      expect(paneIds(result)).toEqual(["a", "b", "c"])

      rerender({ list: archiving(["b"]) })

      expect(paneIds(result)).toEqual(["a", "c"])
      expect(result.current.visibleSessionIds.has("b")).toBe(false)
      // And nothing in the sidebar still thinks it belongs to that split.
      expect(result.current.groupIdBySession.has("b")).toBe(false)
    })

    it("dissolves a group whose every session was archived", () => {
      const { result, rerender } = renderHook(({ list }) => useSplitLayout(list, "a"), {
        initialProps: { list: sessions as ReadonlyArray<{ id: string; archived?: boolean }> }
      })
      act(() => result.current.splitInto(result.current.group!.id, "b", 1))

      rerender({ list: archiving(["a", "b"]) })

      expect(result.current.group).toBeNull()
      expect(result.current.activeSessionId).toBeNull()
    })

    it("keeps focus on the pane the operator was looking at", () => {
      // Archiving a pane to the LEFT of the focused one shifts every index down;
      // focus must follow the session, not the number it used to sit at.
      const { result, rerender } = renderHook(({ list }) => useSplitLayout(list, "a"), {
        initialProps: { list: sessions as ReadonlyArray<{ id: string; archived?: boolean }> }
      })
      act(() => result.current.splitInto(result.current.group!.id, "b", 1))
      act(() => result.current.splitInto(result.current.group!.id, "c", 2))
      act(() => result.current.focusPane(result.current.group!.id, 2))
      expect(result.current.activeSessionId).toBe("c")

      rerender({ list: archiving(["a"]) })

      expect(paneIds(result)).toEqual(["b", "c"])
      expect(result.current.activeSessionId).toBe("c")
    })

    it("does not put a restored session back into the split it left", () => {
      // Rejoining a split is something you ask for by dragging — not a side
      // effect of un-retiring a session.
      const { result, rerender } = renderHook(({ list }) => useSplitLayout(list, "a"), {
        initialProps: { list: sessions as ReadonlyArray<{ id: string; archived?: boolean }> }
      })
      act(() => result.current.splitInto(result.current.group!.id, "b", 1))
      rerender({ list: archiving(["b"]) })
      expect(paneIds(result)).toEqual(["a"])

      rerender({ list: archiving([]) })

      expect(paneIds(result)).toEqual(["a"])
      expect(result.current.groupIdBySession.has("b")).toBe(false)
    })
  })

  /**
   * A divider drag dispatches one workspace per pointer-move, and
   * `localStorage.setItem` is synchronous and disk-backed. Writing through on
   * each one put hundreds of blocking writes on the one interaction that has no
   * frame budget to give away — the divider is supposed to track the cursor, and
   * the pointer handler is what makes it.
   *
   * These count real `setItem` calls rather than inspecting the stored value,
   * because the cost being avoided is the CALL.
   */
  describe("persistence", () => {
    const twoPaneSplit = (result: { current: ReturnType<typeof useSplitLayout> }) => {
      act(() => result.current.splitInto(result.current.group!.id, "b", 1))
    }

    it("writes a structural change through immediately", () => {
      const { result } = renderHook(() => useSplitLayout(sessions, "a"))
      const writes = vi.spyOn(Storage.prototype, "setItem")

      twoPaneSplit(result)
      expect(writes).toHaveBeenCalledTimes(1)

      // Closing, moving and focusing are all structural too.
      act(() => result.current.focusPane(result.current.group!.id, 0))
      act(() => result.current.closePane(result.current.group!.id, 1))
      expect(writes).toHaveBeenCalledTimes(3)
      writes.mockRestore()
    })

    it("coalesces a whole divider drag into ONE write", () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useSplitLayout(sessions, "a"))
      twoPaneSplit(result)
      const writes = vi.spyOn(Storage.prototype, "setItem")

      // A drag: sixty deltas, as `split-view` sends them.
      const groupId = result.current.group!.id
      for (let i = 0; i < 60; i++) {
        act(() => result.current.resizePane(groupId, 0, 0.002))
      }
      expect(writes).not.toHaveBeenCalled()

      act(() => vi.runAllTimers())
      expect(writes).toHaveBeenCalledTimes(1)

      // And what landed is the END of the drag, not some frame in the middle.
      const stored = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!)
      expect(stored.groups[0].panes[0].ratio).toBeCloseTo(
        result.current.group!.panes[0]!.ratio,
        10
      )
      writes.mockRestore()
      vi.useRealTimers()
    })

    it("flushes a pending ratio write when the window goes away", () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useSplitLayout(sessions, "a"))
      twoPaneSplit(result)
      const writes = vi.spyOn(Storage.prototype, "setItem")
      act(() => result.current.resizePane(result.current.group!.id, 0, 0.1))
      expect(writes).not.toHaveBeenCalled()

      act(() => {
        window.dispatchEvent(new Event("pagehide"))
      })

      expect(writes).toHaveBeenCalledTimes(1)
      writes.mockRestore()
      vi.useRealTimers()
    })

    it("flushes a pending ratio write on unmount", () => {
      vi.useFakeTimers()
      const { result, unmount } = renderHook(() => useSplitLayout(sessions, "a"))
      twoPaneSplit(result)
      act(() => result.current.resizePane(result.current.group!.id, 0, 0.1))
      const ratio = result.current.group!.panes[0]!.ratio
      const writes = vi.spyOn(Storage.prototype, "setItem")

      unmount()

      expect(writes).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!)
      expect(stored.groups[0].panes[0].ratio).toBeCloseTo(ratio, 10)
      writes.mockRestore()
      vi.useRealTimers()
    })

    it("does not let a deferred ratio write clobber a later structural change", () => {
      // The ordering hazard: drag a divider, then close a pane before the debounce
      // fires. The close must win, and the stale ratios must never land after it.
      vi.useFakeTimers()
      const { result } = renderHook(() => useSplitLayout(sessions, "a"))
      twoPaneSplit(result)
      act(() => result.current.resizePane(result.current.group!.id, 0, 0.1))
      act(() => result.current.closePane(result.current.group!.id, 1))

      act(() => vi.runAllTimers())

      const stored = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!)
      expect(stored.groups[0].panes.map((p: { sessionId: string }) => p.sessionId)).toEqual(["a"])
      vi.useRealTimers()
    })
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
