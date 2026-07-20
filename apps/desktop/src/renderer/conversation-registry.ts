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
import type { ActivityPhase, Session, SessionActivity } from "@starbase/core"
import { activityOf, latestPlan } from "@starbase/core"
import { conversationMachine } from "./conversation-machine.js"
import { setSessionActivity } from "./session-activity.js"
import { setPlanPresent } from "./plan-presence.js"
import { clearSessionDiff, diffCounts, setSessionDiff } from "./diff-presence.js"
import { isSessionVisible } from "./active-session.js"
import type { NotifiableState } from "./notifier.js"
import { notificationFor } from "./notifier.js"
import { rpc } from "./rpc-client.js"

type ConversationActor = ActorRefFrom<typeof conversationMachine>
type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>

const registry = new Map<string, ConversationActor>()

/** Where the machine is, in the terms `activityOf` reasons about. */
const phaseOf = (snap: ConversationSnapshot): ActivityPhase => {
  if (snap.matches("running")) return "running"
  // The turn is over; we're only re-reading the worktree diff.
  if (snap.matches("refreshingDiff")) return "settling"
  return "idle"
}

/**
 * Derive the live activity the sidebar/tab bar show from a machine snapshot.
 * The interesting part lives in `activityOf` (pure, and tested in core) — this
 * only translates machine states into a phase.
 */
const activityFor = (snap: ConversationSnapshot): SessionActivity | null =>
  activityOf(snap.context.messages, phaseOf(snap))

/**
 * Get (creating + starting on first use) the persistent actor for a session.
 * The subscription publishes live status + plan presence for the whole lifetime
 * of the run, independent of whether the conversation pane is mounted.
 */
export const getConversationActor = (session: Session): ConversationActor => {
  const existing = registry.get(session.id)
  if (existing) return existing

  const actor = createActor(conversationMachine, { input: { session } })
  // Previous observation for the edge detector — see `notificationFor`. Held per
  // actor so it dies with the session rather than leaking into the next one.
  let lastSeen: NotifiableState | null = null
  actor.subscribe((snap) => {
    // Deferred so the very first (synchronous) notification from `start()` — which
    // can happen while a component is rendering, since the actor is created inside
    // `useMemo` — doesn't notify the status/plan stores mid-render.
    const activity = activityFor(snap)
    const planPresent = latestPlan(snap.context.messages) !== null
    const diff = diffCounts(snap.context.patch)
    // Nothing is announced until the transcript has LOADED, and the first loaded
    // snapshot becomes the baseline rather than an edge.
    //
    // `notificationFor`'s own first-observation rule is not enough on its own:
    // the actor's initial `start()` snapshot has empty messages and so reports
    // no activity, and the restored transcript arrives on a LATER transition. A
    // session that was already blocked when the app last closed therefore looked
    // like a null → needs-input edge on observation #2, and announced "Waiting
    // for your input" for state that predates the operator opening the app —
    // precisely the stale-replay noise the rule exists to prevent.
    const observed: NotifiableState = { activity, outcome: snap.context.lastOutcome }
    const announce = snap.context.loaded ? notificationFor(session.title, lastSeen, observed) : null
    if (snap.context.loaded) lastSeen = observed
    queueMicrotask(() => {
      setSessionActivity(session.id, activity)
      setPlanPresent(session.id, planPresent)
      setSessionDiff(session.id, diff)
      // Fire-and-forget, and deliberately last: a notification that fails must
      // never take the status stores down with it. Main decides whether this
      // actually surfaces (window focus + the operator's prefs).
      if (announce !== null) {
        void rpc
          .notifyShow({
            sessionId: session.id,
            kind: announce.kind,
            title: announce.title,
            body: announce.body,
            isActiveSession: isSessionVisible(session.id)
          })
          .catch(() => {})
      }
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
  setSessionActivity(sessionId, null)
  setPlanPresent(sessionId, false)
  clearSessionDiff(sessionId)
}
