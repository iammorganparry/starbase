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
