import { useCallback, useEffect, useMemo, useState } from "react"
import {
  assign,
  clear,
  focus,
  focusedSessionId,
  type GridLayout,
  type LayoutMode,
  load,
  prune,
  save,
  setMode,
  slotIndexBySession
} from "./layout-grid.js"

/**
 * The live session grid: the persisted layout plus the operations the UI drives
 * it with.
 *
 * Thin on purpose — every rule lives in the pure reducers in `layout-grid.ts`, so
 * this hook is only responsible for holding the state, persisting it, and keeping
 * it honest about which sessions still exist.
 */
export function useGridLayout(
  sessions: ReadonlyArray<{ id: string }>,
  initialSessionId?: string | null
) {
  const [layout, setLayout] = useState<GridLayout>(() => {
    const stored = load()
    // Nothing restored and a session to show? Seed slot 0, so first launch (and
    // any fresh profile) lands on a session rather than an empty grid.
    if (stored.slots.every((id) => id === null) && initialSessionId) {
      return assign(stored, 0, initialSessionId)
    }
    return stored
  })

  useEffect(() => {
    save(layout)
  }, [layout])

  // A layout restored from storage names sessions that may since have been
  // deleted (in another window, or by wiping sessions.json). Drop those slots
  // rather than rendering a pane pointed at nothing.
  const knownIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions])
  useEffect(() => {
    // Unconditional, including for an EMPTY list. `StarbaseApp` only mounts once
    // the app machine has left `loading`/`starting` (App.tsx renders LoadingScreen
    // until then), so no sessions here means every session really was deleted —
    // not that they haven't arrived yet. Skipping the prune in that case left the
    // grid holding ids of deleted sessions, persisted them to localStorage, and
    // showed "Drag a session here" placeholders with nothing left to drag instead
    // of the first-launch screen — across restarts.
    setLayout((current) => prune(current, knownIds))
  }, [knownIds])

  /**
   * Show a session, the way a sidebar CLICK means it: put it in the focused slot,
   * replacing whatever was there. In 1-up this is exactly the old single-select
   * behaviour; in a grid it means "the pane I'm looking at, show me this instead".
   */
  const selectSession = useCallback((sessionId: string) => {
    setLayout((current) => {
      // Already on screen? Just look at it. Falling through to `assign` would
      // apply its SWAP semantics — yanking the session out of the pane it is
      // visibly sitting in and pushing the focused pane's session into the hole,
      // rearranging two panes when the operator only wanted to read one. Swap
      // stays the meaning of an explicit DRAG, not of a click.
      const at = current.slots.indexOf(sessionId)
      return at === -1 ? assign(current, current.focused, sessionId) : focus(current, at)
    })
  }, [])

  /** Put a session in a specific slot — what a DROP means. */
  const assignToSlot = useCallback((slot: number, sessionId: string) => {
    setLayout((current) => assign(current, slot, sessionId))
  }, [])

  const clearSlot = useCallback((slot: number) => {
    setLayout((current) => clear(current, slot))
  }, [])

  const focusSlot = useCallback((slot: number) => {
    setLayout((current) => focus(current, slot))
  }, [])

  const changeMode = useCallback((mode: LayoutMode) => {
    setLayout((current) => setMode(current, mode))
  }, [])

  const slotBySession = useMemo(() => slotIndexBySession(layout), [layout])
  /**
   * Every session currently ON SCREEN, not just the focused one. Notification
   * suppression keys off this: the main process's rule is "don't tell them what
   * they can already see", and in a grid that is every gridded session.
   */
  const visibleSessionIds = useMemo(() => new Set(slotBySession.keys()), [slotBySession])

  return {
    layout,
    /** The session in the focused slot — the app's "active session". */
    activeSessionId: focusedSessionId(layout),
    slotBySession,
    visibleSessionIds,
    selectSession,
    assignToSlot,
    clearSlot,
    focusSlot,
    changeMode
  }
}
