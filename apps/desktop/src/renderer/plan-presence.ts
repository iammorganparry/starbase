/**
 * A tiny cross-component store of which sessions currently warrant a Plan Review
 * tab — i.e. the session is in plan mode or has a proposed plan in its transcript.
 * The conversation pane writes to it (it owns the live plan state); the tab bar
 * reads it to decide whether to surface the Plan tab. Mirrors `session-status.ts`.
 *
 * `Session.mode` in the app machine goes stale after a mid-session mode change,
 * so the tab can't key off it directly — this live signal fills that gap.
 */
import { useSyncExternalStore } from "react"

let present: Record<string, true> = {}
const listeners = new Set<() => void>()
const EMPTY: ReadonlySet<string> = new Set()
let snapshot: ReadonlySet<string> = EMPTY

const recompute = () => {
  snapshot = new Set(Object.keys(present))
}

/** Mark (or clear) that a session has a Plan tab worth showing; notifies subscribers. */
export const setPlanPresent = (id: string, value: boolean): void => {
  const has = id in present
  if (value === has) return
  if (value) present = { ...present, [id]: true }
  else {
    const next = { ...present }
    delete next[id]
    present = next
  }
  recompute()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The set of session ids that should show a Plan Review tab. */
export const usePlanSessions = (): ReadonlySet<string> =>
  useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
