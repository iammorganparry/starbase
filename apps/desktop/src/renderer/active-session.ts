/**
 * Which session the operator currently has on screen.
 *
 * A module-level cell rather than React state, because its reader is the
 * conversation REGISTRY — a module that deliberately outlives every component
 * (see `conversation-registry.ts`) and so cannot reach into a context or a hook.
 * The registry needs this to answer one question: "is the session I'm about to
 * notify about the one they're already looking at?"
 *
 * Write-only from React's side: `App.tsx` publishes the selection, nothing here
 * subscribes. That keeps it out of the render path entirely — a session switch
 * must not re-render on account of the notifier.
 */
let active: string | null = null

/** The session on screen, or null when none is selected. */
export const activeSessionId = (): string | null => active

/** Publish the current selection. Called by `App.tsx` when it changes. */
export const setActiveSessionId = (sessionId: string | null): void => {
  active = sessionId
}
