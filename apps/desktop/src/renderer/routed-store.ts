/**
 * A tiny cross-component store of which PR timeline entries have been routed to a
 * session's agent, so the "Send to agent" action stays in its terminal "Sent"
 * state even after the Pull Request tab unmounts/remounts. Mirrors the
 * session-status store pattern.
 */
import { useSyncExternalStore } from "react"

let routed: Record<string, ReadonlySet<string>> = {}
const listeners = new Set<() => void>()
const EMPTY: ReadonlySet<string> = new Set()

/** Record that `entryId` has been routed to `sessionId`'s agent; notifies subscribers. */
export const markRouted = (sessionId: string, entryId: string): void => {
  const current = routed[sessionId] ?? EMPTY
  if (current.has(entryId)) return
  const next = new Set(current)
  next.add(entryId)
  routed = { ...routed, [sessionId]: next }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The set of entry ids already routed for a session (reactive). */
export const useRoutedEntries = (sessionId: string): ReadonlySet<string> =>
  useSyncExternalStore(
    subscribe,
    () => routed[sessionId] ?? EMPTY,
    () => routed[sessionId] ?? EMPTY
  )
