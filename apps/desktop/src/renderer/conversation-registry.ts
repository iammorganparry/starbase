/**
 * A module-level registry of running conversation actors, keyed by session id.
 *
 * The conversation pane is mounted keyed by the *active* session, so switching
 * sessions unmounts it. If the actor lived inside the component (via
 * `useMachine`) that unmount would stop it — tearing down the invoked
 * `agentStream`, whose cleanup interrupts the RPC stream and kills the live run
 * in the main process. Keeping mounted-but-hidden panes isn't an option either
 * (the virtualized transcript's measurement cache corrupts when hidden).
 *
 * So the actor is hoisted here instead: created once per session and kept
 * running across mounts, so a background session's agent keeps working while the
 * operator looks at another. The view just attaches to (and detaches from) the
 * existing actor. Live status + plan-tab presence are published straight from
 * the actor's subscription here, so they stay correct even while the pane that
 * would otherwise report them is unmounted. Actors are disposed when their
 * session is deleted (see `App.tsx`).
 */
import type { ActorRefFrom, SnapshotFrom } from "xstate"
import { createActor } from "xstate"
import type { Session, SessionStatus } from "@starbase/core"
import { latestPlan, pendingPlan, pendingQuestion } from "@starbase/core"
import { conversationMachine } from "./conversation-machine.js"
import { setSessionStatus } from "./session-status.js"
import { setPlanPresent } from "./plan-presence.js"

type ConversationActor = ActorRefFrom<typeof conversationMachine>
type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>

const registry = new Map<string, ConversationActor>()

/** Derive the live status the sidebar/tab bar show from a machine snapshot. */
const statusOf = (snap: ConversationSnapshot): SessionStatus | null => {
  const messages = snap.context.messages
  const last = messages[messages.length - 1]
  const paused =
    last?.role === "assistant" &&
    last.parts.some((p) => p._tag === "Gate" && p.gate.status === "pending")
  const needsInput = paused || pendingQuestion(messages) !== null || pendingPlan(messages) !== null
  if (needsInput) return "needs-input"
  return snap.matches("running") || snap.matches("refreshingDiff") ? "thinking" : null
}

/**
 * Get (creating + starting on first use) the persistent actor for a session.
 * The subscription publishes live status + plan presence for the whole lifetime
 * of the run, independent of whether the conversation pane is mounted.
 */
export const getConversationActor = (session: Session): ConversationActor => {
  const existing = registry.get(session.id)
  if (existing) return existing

  const actor = createActor(conversationMachine, { input: { session } })
  actor.subscribe((snap) => {
    // Deferred so the very first (synchronous) notification from `start()` — which
    // can happen while a component is rendering, since the actor is created inside
    // `useMemo` — doesn't notify the status/plan stores mid-render.
    const status = statusOf(snap)
    const planPresent = latestPlan(snap.context.messages) !== null
    queueMicrotask(() => {
      setSessionStatus(session.id, status)
      setPlanPresent(session.id, planPresent)
    })
  })
  actor.start()
  registry.set(session.id, actor)
  return actor
}

/** Stop + forget a session's actor (call when the session is deleted). */
export const disposeConversationActor = (sessionId: string): void => {
  const actor = registry.get(sessionId)
  if (!actor) return
  actor.stop()
  registry.delete(sessionId)
  setSessionStatus(sessionId, null)
  setPlanPresent(sessionId, false)
}
