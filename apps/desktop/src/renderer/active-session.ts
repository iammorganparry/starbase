/**
 * Which sessions the operator currently has ON SCREEN.
 *
 * A module-level cell rather than React state, because its reader is the
 * conversation REGISTRY — a module that deliberately outlives every component
 * (see `conversation-registry.ts`) and so cannot reach into a context or a hook.
 * The registry needs this to answer one question: "is the session I'm about to
 * notify about one they can already see?"
 *
 * A SET, not a single id, because the session grid can show up to four sessions
 * at once. The main process suppresses a notification only when the window is
 * focused AND the session is on screen (`shouldNotify` in `main/notifications.ts`
 * — "telling someone what they can already see"). Publishing only the FOCUSED
 * session would mean a session sitting visible in the next pane still raised an
 * OS toast, which is exactly the noise that rule exists to prevent.
 *
 * Write-only from React's side: `App.tsx` publishes, nothing here subscribes.
 * That keeps it out of the render path entirely — a session switch must not
 * re-render on account of the notifier.
 */
let visible: ReadonlySet<string> = new Set()

/** Whether a session is on screen right now (in any grid pane). */
export const isSessionVisible = (sessionId: string): boolean => visible.has(sessionId)

/** Publish the sessions currently on screen. Called by `App.tsx` when they change. */
export const setVisibleSessionIds = (sessionIds: ReadonlySet<string>): void => {
  visible = sessionIds
}
