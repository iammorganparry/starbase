/**
 * Turns a session's live machine snapshots into desktop notifications.
 *
 * Notifications are EDGE-triggered, not level-triggered, and that is the whole
 * design. A conversation actor publishes a snapshot on every token, so "this
 * session needs input" is true for thousands of consecutive snapshots — firing
 * on the state rather than the transition into it would produce a notification
 * storm for a single question. `notificationFor` therefore compares the previous
 * observation with the current one and speaks only when something CHANGED.
 *
 * The decision is split with the main process on purpose: main knows whether the
 * window is focused and what the operator's prefs are, and applies both (see
 * `main/notifications.ts`). This module knows what happened and to which
 * session. Keeping the pure part here — `notificationFor` — means the edge rules
 * are testable without Electron, an actor, or a clock.
 */
import type { NotificationKind, SessionActivity } from "@starbase/core"

/** The slice of a session's state a notification decision depends on. */
export interface NotifiableState {
  readonly activity: SessionActivity | null
  /** How the last run ended, or null while one is in flight. */
  readonly outcome: "done" | "failed" | null
}

export interface NotificationPlan {
  readonly kind: NotificationKind
  readonly title: string
  readonly body: string
}

/**
 * What (if anything) to announce for a session that moved from `prev` to `next`.
 *
 * `prev` is null on the first observation of a session — typically at app
 * start, when actors are created for sessions that may already be mid-run or
 * already blocked. Treated as "nothing to announce": telling the operator about
 * a state that predates them opening the app is noise, and on a workspace with
 * twenty sessions it is twenty notifications at once.
 */
export const notificationFor = (
  sessionTitle: string,
  prev: NotifiableState | null,
  next: NotifiableState
): NotificationPlan | null => {
  if (prev === null) return null

  const wasBlocked = isBlocked(prev.activity)
  const isNowBlocked = isBlocked(next.activity)
  if (!wasBlocked && isNowBlocked) {
    const approval = next.activity?.kind === "needs-approval"
    return {
      kind: "needs-input",
      title: sessionTitle,
      body: approval ? "Waiting for you to approve a plan." : "Waiting for your input."
    }
  }

  // A run's outcome is recorded once, on the event that ends it, so the
  // transition out of null IS the edge. Comparing the values themselves would
  // re-announce every snapshot of an already-finished run.
  if (prev.outcome === null && next.outcome !== null) {
    return next.outcome === "failed"
      ? { kind: "failed", title: sessionTitle, body: "The run failed." }
      : { kind: "done", title: sessionTitle, body: "Finished its run." }
  }

  return null
}

/** Both kinds of "the agent has stopped and is waiting on a human". */
const isBlocked = (activity: SessionActivity | null): boolean =>
  activity?.kind === "needs-input" || activity?.kind === "needs-approval"

/** What to say when a session's PR is resolved on GitHub. */
export const prNotification = (
  sessionTitle: string,
  state: "merged" | "closed"
): NotificationPlan => ({
  kind: "pr",
  title: sessionTitle,
  body: state === "merged" ? "Its pull request was merged." : "Its pull request was closed."
})
