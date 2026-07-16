/**
 * A tiny cross-component store of what each session's agent is *doing right now*
 * ("Running npm test", "Monitoring PR #482", "Needs input"). The conversation
 * registry writes to it from the actor's own subscription; the sidebar and tab
 * bar read it.
 *
 * Live-only by design: the persisted `Session.status` is a coarse lifecycle that
 * can't say what KIND of work is in flight. Absent here → the reader falls back
 * to that persisted status.
 */
import { useSyncExternalStore } from "react"
import type { SessionActivity } from "@starbase/core"

let activities: Record<string, SessionActivity> = {}
const listeners = new Set<() => void>()

const same = (a: SessionActivity | undefined, b: SessionActivity): boolean =>
  a?.kind === b.kind && a.verb === b.verb && a.target === b.target

/** Set (or clear, with `null`) a session's live activity; notifies subscribers. */
export const setSessionActivity = (id: string, activity: SessionActivity | null): void => {
  if (activity === null) {
    if (!(id in activities)) return
    const next = { ...activities }
    delete next[id]
    activities = next
  } else {
    // Value-compare, not identity: the registry rebuilds the activity object on
    // EVERY snapshot, so an identity check would notify on every streamed token.
    if (same(activities[id], activity)) return
    activities = { ...activities, [id]: activity }
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live activities, keyed by session id. Absent → fall back to `Session.status`. */
export const useSessionActivities = (): Record<string, SessionActivity> =>
  useSyncExternalStore(
    subscribe,
    () => activities,
    () => activities
  )
