/**
 * A tiny cross-component store of each session's *live* status (thinking /
 * needs-input) while its agent runs. The conversation pane writes to it; the
 * sidebar and tab bar read it to reflect the real agent state, since the
 * persisted `Session.status` doesn't change during a run.
 */
import { useSyncExternalStore } from "react"
import type { SessionStatus } from "@starbase/core"

let statuses: Record<string, SessionStatus> = {}
const listeners = new Set<() => void>()

/** Set (or clear, with `null`) a session's live status; notifies subscribers. */
export const setSessionStatus = (id: string, status: SessionStatus | null): void => {
  if (status === null) {
    if (!(id in statuses)) return
    const next = { ...statuses }
    delete next[id]
    statuses = next
  } else {
    if (statuses[id] === status) return
    statuses = { ...statuses, [id]: status }
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live statuses, keyed by session id. Absent → fall back to the persisted status. */
export const useSessionStatuses = (): Record<string, SessionStatus> =>
  useSyncExternalStore(
    subscribe,
    () => statuses,
    () => statuses
  )
