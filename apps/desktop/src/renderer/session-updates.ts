/**
 * A one-way channel for session records the conversation machine writes back,
 * so `appMachine`'s session list doesn't go stale behind them.
 *
 * Every session mutation the *view* drives goes through App.tsx, which sends
 * `SESSION_UPDATED` with the record the RPC returned. But the machine persists a
 * session's settled status by itself, deep inside a state entry — with no route
 * back to App.tsx. Without this the sidebar keeps rendering the pre-write
 * `session.status` (its fallback whenever there's no live activity) until the app
 * restarts, which defeats the point of writing it at all.
 *
 * Not a `useSyncExternalStore` store like `session-activity`: this is an event,
 * not a snapshot — App.tsx forwards each one into the machine rather than
 * rendering from it.
 */
import type { Session } from "@starbase/core"

type Listener = (session: Session) => void

const listeners = new Set<Listener>()

/** Announce a session record the backend just returned. */
export const publishSessionUpdate = (session: Session): void => {
  for (const listener of listeners) listener(session)
}

/** Subscribe to session records written outside the view; returns an unsubscribe. */
export const onSessionUpdate = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
