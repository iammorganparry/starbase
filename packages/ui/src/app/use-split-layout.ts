import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  replacePane,
  resize,
  save,
  separateAll,
  show,
  splitWith,
  visibleSessionIds,
  type Workspace
} from "./split-layout.js"

/**
 * How long a ratio-only change waits before it is written.
 *
 * Comfortably longer than the gap between pointer-moves (~8–16ms), so a drag
 * coalesces to a single write, and short enough that letting go of a divider and
 * immediately quitting still persists what you did.
 */
const RATIO_SAVE_DELAY_MS = 200

/**
 * Everything about a workspace EXCEPT the pane ratios.
 *
 * The discriminator between "the operator rearranged something" and "the
 * operator is dragging a divider". Deliberately a string rather than a deep
 * compare: it is computed on every state change, including every pointer-move,
 * so it has to be cheap — and a workspace is at most a handful of groups of at
 * most four panes, which makes this a few dozen characters.
 */
const structureOf = (ws: Workspace): string =>
  `${ws.activeGroupId ?? ""}|${ws.groups
    .map((g) => `${g.id}:${g.focused}:${g.panes.map((p) => p.sessionId).join(",")}`)
    .join(";")}`

/**
 * The live workspace: the persisted split state plus the operations the UI
 * drives it with.
 *
 * Thin on purpose — every rule lives in the pure reducers in `split-layout.ts`,
 * so this hook is only responsible for holding the state, persisting it, and
 * keeping it honest about which sessions are still eligible for a pane. Same
 * shape and same division of labour as the preset-slot grid hook it replaces.
 *
 * Takes the smallest shape it actually reads rather than `Session`, so the tests
 * can drive it with two-field literals.
 */
export function useSplitLayout(
  sessions: ReadonlyArray<{ readonly id: string; readonly archived?: boolean }>,
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

  /**
   * Persist — but never once per pointer-move.
   *
   * `resize` dispatches a fresh workspace for every `pointermove` of a divider
   * drag, so a plain write-through effect ran `JSON.stringify` +
   * `localStorage.setItem` at pointer rate for the length of the drag.
   * `setItem` is synchronous and disk-backed, and it was landing on the one
   * interaction with no frame budget to give away: a divider is supposed to
   * track the cursor exactly, and the pointer handler is what makes it.
   *
   * So writes are split by what changed, not blanket-debounced:
   *
   * - **Structure** — which groups exist, which sessions are in which panes, in
   *   what order, and which one has focus — is written THROUGH, exactly as
   *   before. Those are discrete, deliberate acts (split, close, move, focus),
   *   and each is worth a write the moment it happens.
   * - **Ratios alone** — the divider drag, and nothing else in the model — are
   *   coalesced, so one drag costs one write instead of several hundred.
   *
   * Keeping structure write-through is what makes the deferral safe to reason
   * about: the only thing a lost debounce window can cost is a few pixels of
   * divider position, never a pane.
   */
  const savedStructure = useRef<string | null>(null)
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(workspace)

  const flushSave = useCallback(() => {
    if (pendingSave.current === null) return
    clearTimeout(pendingSave.current)
    pendingSave.current = null
    save(latest.current)
  }, [])

  useEffect(() => {
    latest.current = workspace
    const structure = structureOf(workspace)
    const structural = structure !== savedStructure.current
    savedStructure.current = structure

    if (structural) {
      // Also covers the very first run, where `savedStructure` is null — which
      // is what writes a freshly migrated `sb.layout.v1` back in the new shape
      // immediately rather than a debounce later.
      if (pendingSave.current !== null) {
        clearTimeout(pendingSave.current)
        pendingSave.current = null
      }
      save(workspace)
      return
    }

    if (pendingSave.current !== null) clearTimeout(pendingSave.current)
    pendingSave.current = setTimeout(() => {
      pendingSave.current = null
      save(latest.current)
    }, RATIO_SAVE_DELAY_MS)
  }, [workspace])

  // A pending ratio write must not be lost to the window going away. `pagehide`
  // covers the app quitting or reloading; the unmount cleanup covers the shell
  // being torn down with the window still up. Both are cheap no-ops when there
  // is nothing pending.
  useEffect(() => {
    const onHide = () => flushSave()
    window.addEventListener("pagehide", onHide)
    return () => {
      window.removeEventListener("pagehide", onHide)
      flushSave()
    }
  }, [flushSave])

  const sessionIndex = useMemo(() => {
    const exists = new Set<string>()
    const archived = new Set<string>()
    for (const s of sessions) {
      exists.add(s.id)
      if (s.archived) archived.add(s.id)
    }
    return { exists, archived }
  }, [sessions])

  /**
   * Keep the workspace honest about which sessions may hold a pane.
   *
   * Two rules, and the second is narrower than it first looks:
   *
   * 1. **Gone means gone.** A workspace restored from storage names sessions
   *    that may since have been deleted (in another window, or by wiping
   *    sessions.json). A pane pointed at nothing is worse than no pane.
   *
   * 2. **Archiving takes a session out of a SPLIT, but not off the screen.** An
   *    archived session sharing a group with others is dropped from it; one that
   *    is alone in its group keeps it.
   *
   * The asymmetry in (2) is the point, and it is the sidebar that forces it. A
   * session in a multi-pane group is drawn as a segment of that group's pill —
   * and if it is also archived it is drawn AGAIN as a row under Archived, with
   * both elements carrying `layoutId="session-<id>"`. Two mounted elements
   * sharing a layoutId is undefined in motion; the shared-element tween can snap
   * either to the other's box, so the archived row would fly across the sidebar
   * and land on the pill. A group of ONE has no pill — it is an ordinary row —
   * so there is no duplicate to create and nothing to fix.
   *
   * Dropping archived sessions outright was the first attempt, and it broke
   * something real: reading an archived session is a supported thing to do (it
   * gets a "was merged" banner and a locked composer), and clicking its row puts
   * it in a group of one. Evicting those made the read-only view unreachable —
   * the pane was removed on the very next render.
   *
   * Restoring does not put a session back into the split it was archived out of.
   * Rejoining is something you ask for by dragging, not a side effect of
   * un-retiring.
   */
  useEffect(() => {
    // Unconditional, including for an EMPTY list. `StarbaseApp` only mounts once
    // the app machine has left `loading`/`starting` (App.tsx renders LoadingScreen
    // until then), so no sessions here means every session really was deleted —
    // not that they haven't arrived yet. Skipping the prune in that case left the
    // old grid holding ids of deleted sessions and persisting them across
    // restarts.
    setWorkspace((current) => {
      const eligible = new Set<string>()
      for (const group of current.groups) {
        for (const pane of group.panes) {
          if (!sessionIndex.exists.has(pane.sessionId)) continue
          if (group.panes.length > 1 && sessionIndex.archived.has(pane.sessionId)) continue
          eligible.add(pane.sessionId)
        }
      }
      return prune(current, eligible)
    })
  }, [sessionIndex])

  /** Show a session — what a sidebar CLICK means. Never moves it if it's on screen. */
  const selectSession = useCallback((sessionId: string) => {
    setWorkspace((current) => show(current, sessionId))
  }, [])

  /** Put a session beside an existing pane — what a DROP means. */
  const splitInto = useCallback((groupId: string, sessionId: string, at: number) => {
    setWorkspace((current) => splitWith(current, groupId, sessionId, at))
  }, [])

  /** Swap a pane's session — what a drop onto a pane's MIDDLE means. */
  const replace = useCallback((groupId: string, index: number, sessionId: string) => {
    setWorkspace((current) => replacePane(current, groupId, index, sessionId))
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
    replacePane: replace,
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
