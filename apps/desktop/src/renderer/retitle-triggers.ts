import type { Session } from "@starbase/core"

/**
 * Auto-named session ids whose plan JUST appeared — present in `next` (a plan was
 * proposed / the session is in plan mode) but absent in `prev`. This is the
 * trigger for App.tsx to retitle a session right after PLANNING, so its name
 * reflects the work as soon as there's a plan, instead of staying "Untitled"
 * until the whole run (plan + execution) finally completes.
 *
 * Only `autoTitle === true` sessions qualify — a manually-named session is pinned
 * and never auto-retitled. Pure, so the App effect stays thin wiring.
 */
export const newlyPlannedSessionIds = (
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
  sessions: ReadonlyArray<Pick<Session, "id" | "autoTitle">>
): ReadonlyArray<string> =>
  [...next].filter(
    (id) => !prev.has(id) && sessions.find((s) => s.id === id)?.autoTitle === true
  )
