/**
 * A tiny cross-component store of each session's *live* worktree diff totals
 * (added / removed line counts). The conversation registry writes to it from the
 * actor subscription (so it stays live even while the pane is unmounted); the
 * main tab bar reads it to show `+N −N` on the Changes tab — the persisted
 * `Session.diff` is never updated during a run, so this fills that gap. Mirrors
 * `session-status.ts`.
 */
import { useSyncExternalStore } from "react"
import type { DiffStat } from "@starbase/core"

let diffs: Record<string, DiffStat> = {}
const listeners = new Set<() => void>()

/** Count added/removed lines in a unified diff, ignoring the `+++`/`---` headers. */
export const diffCounts = (patch: string): DiffStat => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/** Set (or clear, when 0/0) a session's live diff totals; notifies subscribers. */
export const setSessionDiff = (id: string, stat: DiffStat): void => {
  const prev = diffs[id]
  if (stat.added === 0 && stat.removed === 0) {
    if (prev === undefined) return
    const next = { ...diffs }
    delete next[id]
    diffs = next
  } else {
    if (prev && prev.added === stat.added && prev.removed === stat.removed) return
    diffs = { ...diffs, [id]: stat }
  }
  for (const listener of listeners) listener()
}

/** Clear a session's diff (on dispose). */
export const clearSessionDiff = (id: string): void => setSessionDiff(id, { added: 0, removed: 0 })

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live worktree diff totals, keyed by session id. Absent → no changes. */
export const useSessionDiffs = (): Record<string, DiffStat> =>
  useSyncExternalStore(
    subscribe,
    () => diffs,
    () => diffs
  )
