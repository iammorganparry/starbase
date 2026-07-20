import type { PrState, Session } from "@starbase/core"

/**
 * Session ids whose linked PR has MERGED and whose linked issue should now be
 * closed — opted in via `automations.closeOnMerge`, and not already closed.
 *
 * This is all that remains of what used to be the "archive sweep". Archiving on
 * merge was wrong: a session record holds a single `prNumber`, but one session
 * routinely outlives several PRs (open one, merge it, keep working off the same
 * worktree, open the next). Merging PR #204 therefore said nothing about whether
 * the WORK was done, and a live multi-PR session would silently vanish from the
 * sidebar mid-flight. Retiring a session is now always the operator's call — the
 * merged/closed state only badges the row.
 *
 * Closing the linked ISSUE survives that change because it's a statement about
 * the issue, not about whether the session is finished.
 *
 * `alreadyClosed` is load-bearing: a merged PR stays merged forever, so without
 * it the poll would re-fire the close on every tick.
 */
/**
 * Sessions whose linked PR has just RESOLVED (merged or closed) and should raise
 * a desktop notification, paired with which it was.
 *
 * Pure, and keyed off the same `Record<sessionId, PrState>` as
 * `issuesToCloseOnMerge`, because the first version of this lived inline in the
 * effect and indexed that Record with the loop's numeric INDEX — always
 * undefined for a real session id, so the notification never fired and the whole
 * "PR merged/closed" kind was dead code that still typechecked (TypeScript
 * permits numeric indexing of a `Record<string, T>`). Extracted here so the
 * lookup is exercised by a test rather than by eye.
 *
 * `alreadyNotified` plays the same role as `alreadyClosed` above: a merged PR
 * stays merged, so without it the poll re-announces it every tick.
 */
/** A session whose linked PR has resolved, and how. */
export interface ResolvedPr {
  readonly session: Session
  readonly state: "merged" | "closed"
}

export const prsToNotify = (
  prStates: Readonly<Record<string, PrState>>,
  sessions: ReadonlyArray<Session>,
  alreadyNotified: ReadonlySet<string>
): ReadonlyArray<ResolvedPr> =>
  sessions.flatMap((session) => {
    const state = prStates[session.id]
    if (state !== "merged" && state !== "closed") return []
    if (alreadyNotified.has(session.id)) return []
    return [{ session, state }]
  })

export const issuesToCloseOnMerge = (
  prStates: Readonly<Record<string, PrState>>,
  sessions: ReadonlyArray<Session>,
  alreadyClosed: ReadonlySet<string>
): ReadonlyArray<string> =>
  sessions
    .filter(
      (s) =>
        prStates[s.id] === "merged" &&
        s.issueNumber != null &&
        s.automations?.closeOnMerge === true &&
        !alreadyClosed.has(s.id)
    )
    .map((s) => s.id)
