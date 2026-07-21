import { useCallback, useEffect, useMemo, useState } from "react"
import {
  activate,
  activeGroup,
  closePane,
  focusAdjacent,
  focusedSessionId,
  focusPane,
  groupOf,
  load,
  movePane,
  prune,
  resize,
  save,
  separateAll,
  show,
  splitWith,
  visibleSessionIds,
  type Workspace
} from "./split-layout.js"

/**
 * The live workspace: the persisted split state plus the operations the UI
 * drives it with.
 *
 * Thin on purpose — every rule lives in the pure reducers in `split-layout.ts`,
 * so this hook is only responsible for holding the state, persisting it, and
 * keeping it honest about which sessions still exist. Same shape and same
 * division of labour as the preset-slot grid hook it replaces.
 */
export function useSplitLayout(
  sessions: ReadonlyArray<{ id: string }>,
  initialSessionId?: string | null
) {
  const [workspace, setWorkspace] = useState<Workspace>(() => {
    const stored = load()
    // Nothing restored (and nothing to migrate) but a session to show? Seed it,
    // so first launch — and any fresh profile — lands on a session rather than an
    // empty workspace.
    if (stored.groups.length === 0 && initialSessionId) return show(stored, initialSessionId)
    return stored
  })

  useEffect(() => {
    save(workspace)
  }, [workspace])

  // A workspace restored from storage names sessions that may since have been
  // deleted (in another window, or by wiping sessions.json). Drop those panes
  // rather than rendering one pointed at nothing.
  const knownIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions])
  useEffect(() => {
    // Unconditional, including for an EMPTY list. `StarbaseApp` only mounts once
    // the app machine has left `loading`/`starting` (App.tsx renders LoadingScreen
    // until then), so no sessions here means every session really was deleted —
    // not that they haven't arrived yet. Skipping the prune in that case left the
    // old grid holding ids of deleted sessions and persisting them across
    // restarts.
    setWorkspace((current) => prune(current, knownIds))
  }, [knownIds])

  /** Show a session — what a sidebar CLICK means. Never moves it if it's on screen. */
  const selectSession = useCallback((sessionId: string) => {
    setWorkspace((current) => show(current, sessionId))
  }, [])

  /** Put a session beside an existing pane — what a DROP means. */
  const splitInto = useCallback((groupId: string, sessionId: string, at: number) => {
    setWorkspace((current) => splitWith(current, groupId, sessionId, at))
  }, [])

  const close = useCallback((groupId: string, index: number) => {
    setWorkspace((current) => closePane(current, groupId, index))
  }, [])

  const move = useCallback((groupId: string, index: number, direction: -1 | 1) => {
    setWorkspace((current) => movePane(current, groupId, index, direction))
  }, [])

  const separate = useCallback((groupId: string) => {
    setWorkspace((current) => separateAll(current, groupId))
  }, [])

  const resizePane = useCallback((groupId: string, index: number, delta: number) => {
    setWorkspace((current) => resize(current, groupId, index, delta))
  }, [])

  const focus = useCallback((groupId: string, index: number) => {
    setWorkspace((current) => focusPane(current, groupId, index))
  }, [])

  const focusNeighbour = useCallback((direction: -1 | 1) => {
    setWorkspace((current) => focusAdjacent(current, direction))
  }, [])

  const activateGroup = useCallback((groupId: string) => {
    setWorkspace((current) => activate(current, groupId))
  }, [])

  /**
   * Close the pane that currently has focus — what ⌘W means with a split open.
   * A separate callback because the keyboard has no group id to hand.
   */
  const closeFocused = useCallback(() => {
    setWorkspace((current) => {
      const group = activeGroup(current)
      return group === null ? current : closePane(current, group.id, group.focused)
    })
  }, [])

  /** Move the focused pane one place left or right — Arc's Move Left / Move Right. */
  const moveFocused = useCallback((direction: -1 | 1) => {
    setWorkspace((current) => {
      const group = activeGroup(current)
      return group === null ? current : movePane(current, group.id, group.focused, direction)
    })
  }, [])

  const group = useMemo(() => activeGroup(workspace), [workspace])
  /**
   * Every session currently ON SCREEN, not just the focused one. Notification
   * suppression keys off this: the main process's rule is "don't tell them what
   * they can already see", and in a split that is every pane of the active group.
   */
  const visible = useMemo(() => visibleSessionIds(workspace), [workspace])
  /** Which group each session sits in — what the sidebar renders its rows from. */
  const groupIdBySession = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of workspace.groups) {
      for (const p of g.panes) map.set(p.sessionId, g.id)
    }
    return map
  }, [workspace])

  return {
    workspace,
    /** The group on screen, or null when nothing is. */
    group,
    /** The session in the focused pane — the app's "active session". */
    activeSessionId: focusedSessionId(workspace),
    visibleSessionIds: visible,
    groupIdBySession,
    /** The group holding a session, for callers that only know the session. */
    groupOfSession: useCallback((sessionId: string) => groupOf(workspace, sessionId), [workspace]),
    selectSession,
    splitInto,
    closePane: close,
    closeFocused,
    movePane: move,
    moveFocused,
    separateAll: separate,
    resizePane,
    focusPane: focus,
    focusNeighbour,
    activateGroup
  }
}
